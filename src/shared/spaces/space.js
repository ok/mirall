// Space lifecycle: create/join/leave of spaces and their local spaces-meta records,
// per-space drive management (create, load, purge of on-disk cores), serialized
// member-roster mutation, durable leave tombstones, pending join requests, and
// pinning of the creator root the membership fold trusts.
import { createLocalBee, createDrive, getStore, storeEpoch, hasMasterSecret, deriveSpaceContentKey, isStorageInconsistency } from '../core/store.js'
import { getContentKey, putContentKey } from './space-keys.js'
import { isMembershipApprovalEnabled, isInPlaceFilesEnabled } from '../core/runtime-config.js'
import { markApproval, clearRequest, markSpaceDriveKey, markSpaceLooseCatalogKey, markSpaceLooseCatalogKeyEnc, getLocalPublicKeyHex, clearOwnMembership, hasOwnApproval } from './profile.js'
import { ownCatalogPublish } from '../shares/share-catalog.js'
import { listOwnedMounts, deleteOwnedMount, listForeignMounts, deleteForeignMount } from '../folders/mount-store.js'
import { readOwnShares, tombstoneShare } from '../shares/shares.js'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import keysMod from 'hypercore-storage/lib/keys.js'
import { createLogger } from '../core/logger.js'
import { Subsystem } from '../core/subsystem.js'
import { record } from '../audit/audit-log.js'

const log = createLogger('space')
const { store: keysStore, core: keysCore } = keysMod

// Publish our per-space loose-catalog key alongside the drive key so co-members fold
// it from records (the same path driveKey uses). Requires the space RECORD to exist
// (the key derives from it via catalogNameFor); callers pass the record they already
// hold, so this adds no extra read and never publishes before the record is saved.
async function publishLooseCatalogKey (spaceId, space) {
  if (!space) { log.warn('skipping loose-catalog key publish — no space record:', spaceId); return }
  const pub = await ownLooseCatalogPublish(spaceId)
  if (!pub) return
  try {
    if (pub.encrypted) await markSpaceLooseCatalogKeyEnc(spaceId, pub.keyHex)
    else await markSpaceLooseCatalogKey(spaceId, pub.keyHex)
  } catch (err) { log.debug('loose-catalog key publish failed:', err.message) }
}

// Carried in the handshake so co-members in a v1 space (no member-view fold to hydrate it from
// records) can open our loose catalog. Returns { keyHex, encrypted } — the same value
// publishLooseCatalogKey writes to the profile bee — so the handshake lands it in the matching
// member field (…Enc when the catalog is v2, i.e. encrypted with the space content key, SCK).
export async function ownLooseCatalogPublish (spaceId) {
  if (!isInPlaceFilesEnabled()) return null
  try { return await ownCatalogPublish(spaceId) } catch (err) { log.debug('own loose-catalog key resolve failed:', err.message); return null }
}

// Deletes the core's alias (TL_CORE_BY_DKEY), TL_CORE range, and TL_DATA
// range. hypercore-storage's built-in deleteCore short-circuits when auth
// is missing, which leaves zombie aliases behind and crashes later opens
// with unslab / STORAGE_EMPTY. Writing the deletions directly avoids that.
export async function purgeCoreDk(cs, _db, dkHex) {
  const dkBuf = b4a.from(dkHex, 'hex')
  const storage = await cs.storage.resumeCore(dkBuf)
  if (!storage) return
  const { corePointer, dataPointer } = storage.core
  try {
    const tx = cs.storage.db.write({ autoDestroy: true })
    tx.tryDelete(keysStore.core(dkBuf))
    tx.tryDeleteRange(keysCore.core(corePointer), keysCore.core(corePointer + 1))
    tx.tryDeleteRange(keysCore.data(dataPointer), keysCore.data(dataPointer + 1))
    await tx.flush()
  } finally {
    try { await storage.close() } catch {}
  }
  log.info('deleted core, dk:', dkHex.slice(0, 12))
}

// Reclaim a writable core's on-disk bytes: clear its blocks (which registers
// RocksDB blob-file garbage) then delete the header/alias. A bare purgeCoreDk
// range-delete leaves blob-separated values stranded — no compaction frees them
// (garbage stays 0); the clear is what makes them reclaimable. Caller compacts.
export async function clearAndPurgeCore(cs, db, core) {
  await core.ready()
  try { await core.clear(0, core.length) } catch (err) { log.warn('core.clear before purge failed:', err.message) }
  const dkHex = b4a.toString(core.discoveryKey, 'hex')
  try { await core.close() } catch {}
  await purgeCoreDk(cs, db, dkHex)
}

// Removes the TL_CORE_BY_ALIAS entry that maps a (namespace, name) pair to
// a discovery key. Required when purging a drive: corestore.get({ name })
// resolves the alias first; without this, a same-name reopen after purge
// returns the old discovery key and throws STORAGE_EMPTY because the core
// itself was deleted.
export async function purgeAlias(cs, namespace, name) {
  if (!namespace || !name) return
  const aliasKey = keysStore.coreByAlias({ namespace, name })
  const tx = cs.storage.db.write({ autoDestroy: true })
  tx.tryDelete(aliasKey)
  await tx.flush()
  log.info('deleted alias:', name)
}

// Drive namespace per (peer, space). The optional suffix decouples drive
// identity across rejoins: a peer who leaves and rejoins gets a fresh
// suffix, so others see the new participation as a new drive (empty)
// rather than the deterministic-key resurrection of the old one. Records
// without a suffix resolve to the plain unsuffixed name.
function makeDriveName(spaceId, driveSuffix) {
  return driveSuffix
    ? 'space-drive-' + spaceId + '-' + driveSuffix
    : 'space-drive-' + spaceId
}

function makeDriveSuffix() {
  return b4a.toString(crypto.randomBytes(8), 'hex')
}

export function formatInviteCode(topicHex) {
  return topicHex.match(/.{1,8}/g).join('-')
}

export function parseInviteCode(code) {
  return code.replace(/-/g, '')
}

let spacesBee
let spacesStore = -1
const drives = new Map()

export async function initSpaces() {
  if (spacesBee && spacesStore === storeEpoch() && !spacesBee.core.closed) return
  spacesStore = storeEpoch()
  spacesBee = createLocalBee('spaces-meta')
  await spacesBee.ready()
}

// Per-space content key (SCK), or null for v1/unencrypted spaces. A space I created
// re-derives from M if the vault entry is ever lost; a space I joined has it only
// from the grant stored in the vault.
export function getSpaceContentKey(spaceId, space) {
  if (!space || space.schemaVersion !== 2) return null
  return getContentKey(spaceId) || (space.sckDerivable ? deriveSpaceContentKey(spaceId) : null)
}

export async function createSpace(name, icon = 'folder') {
  const topic = crypto.randomBytes(32)
  const topicHex = b4a.toString(topic, 'hex')
  const spaceId = topicHex.slice(0, 16)
  const driveSuffix = makeDriveSuffix()

  const v2 = isMembershipApprovalEnabled() && hasMasterSecret()
  let sck = null
  if (v2) {
    sck = deriveSpaceContentKey(spaceId)
    await putContentKey(spaceId, sck)
  }

  const drive = createDrive(makeDriveName(spaceId, driveSuffix), { encryptionKey: sck })
  await drive.ready()
  drives.set(spaceId, drive)
  // Publish our drive key so co-members (incl. ones who only derive us from records) can open it.
  if (v2) await markSpaceDriveKey(spaceId, b4a.toString(drive.key, 'hex'))

  const space = {
    name,
    icon,
    topic: topicHex,
    created: new Date().toISOString(),
    members: [],
    driveSuffix,
    // creatorKey is the root of the membership OR-Set (conflict-free add/remove set)
    // fold. I created this space, so I am its root — stamp myself. v2-only: v1 has
    // no membership fold.
    ...(v2 ? { schemaVersion: 2, sckDerivable: true, creatorKey: getLocalPublicKeyHex() } : {}),
  }
  await spacesBee.put('space/' + spaceId, space)
  // AFTER the record exists, so ownCatalog resolves the canonical (suffixed) core —
  // getSpace() returns null before this put.
  await publishLooseCatalogKey(spaceId, space)

  return { spaceId, ...space, driveKey: b4a.toString(drive.key, 'hex') }
}

export async function joinSpace(topicHex, name = 'Unnamed Space', icon = 'folder', { schemaVersion, inviteId, creator } = {}) {
  const spaceId = topicHex.slice(0, 16)

  const existing = await spacesBee.get('space/' + spaceId)
  if (existing) {
    // A surviving durable `leaving` marker (an interrupted leave whose boot completion failed)
    // must not outlive a rejoin — boot would otherwise resume the leave and silently delete the
    // space the user just rejoined. Rejoining is the user's decision that the leave is off.
    if (existing.value.leaving) {
      await mutateSpace(spaceId, (space) => {
        const next = { ...space }
        delete next.leaving
        return next
      })
      delete existing.value.leaving
    }
    const sck = getSpaceContentKey(spaceId, { spaceId, ...existing.value })
    if (existing.value.status !== 'pending' && !drives.has(spaceId)) {
      const drive = createDrive(makeDriveName(spaceId, existing.value.driveSuffix), { encryptionKey: sck })
      await drive.ready()
      drives.set(spaceId, drive)
    }
    return { spaceId, ...existing.value }
  }

  const driveSuffix = makeDriveSuffix()

  // v2 join: stay pending and DON'T create the writable drive yet — it must be
  // encrypted from block 0 once the granted SCK arrives (hypercore can't
  // retro-encrypt). materializeOwnDrive creates it on grant.
  if (schemaVersion === 2 && isMembershipApprovalEnabled() && hasMasterSecret()) {
    const space = {
      name,
      icon,
      topic: topicHex,
      created: new Date().toISOString(),
      members: [],
      driveSuffix,
      schemaVersion: 2,
      status: 'pending',
      ...(inviteId ? { inviteId } : {}),
      // The invite's creator (envelope `c`) is an UNAUTHENTICATED bearer hint —
      // pre-seed it so the waiting view isn't empty, but mark it provisional. onGrant
      // authoritatively pins/corrects it from the authenticated SCK-grant before this space
      // ever folds a member set. Distinct from the pre-seeded inviter (`owner`): the fold
      // must seed from the creator, not whichever member's invite we joined through.
      ...(creator ? { creatorKey: creator, creatorUnverified: true } : {}),
    }
    await spacesBee.put('space/' + spaceId, space)
    return { spaceId, ...space, driveKey: null, pending: true }
  }

  const drive = createDrive(makeDriveName(spaceId, driveSuffix))
  await drive.ready()
  drives.set(spaceId, drive)

  const space = {
    name,
    icon,
    topic: topicHex,
    created: new Date().toISOString(),
    members: [],
    driveSuffix,
  }
  await spacesBee.put('space/' + spaceId, space)
  await publishLooseCatalogKey(spaceId, space)

  return { spaceId, ...space, driveKey: b4a.toString(drive.key, 'hex') }
}

export async function listSpaces() {
  const spaces = []
  for await (const entry of spacesBee.createReadStream({ gte: 'space/', lt: 'space0' })) {
    const spaceId = entry.key.replace('space/', '')
    spaces.push({ spaceId, ...entry.value })
  }
  return spaces
}

export async function getSpace(spaceId) {
  const entry = await spacesBee.get('space/' + spaceId)
  return entry ? { spaceId, ...entry.value } : null
}

export async function updateMembers(spaceId, members) {
  const entry = await spacesBee.get('space/' + spaceId)
  if (!entry) return
  await spacesBee.put('space/' + spaceId, { ...entry.value, members })
}

// Per-space serialization of every read-modify-write of the member list. A peer
// joining a space that already has 2+ members fires several handshakes at once,
// and leave-frames / reconcile-prunes can land concurrently with them. Writing
// the whole roster from a stale read would silently drop concurrent updates —
// the last writer clobbers the others, and a joiner could permanently miss a
// co-member (typically the owner) until a reconnect. So: funnel all member
// mutations through a per-space promise chain and re-read inside it, so each
// write sees the previous one.
const memberWriteChains = new Map()

// `mutate(members)` gets a fresh deep-ish copy of the current member list and
// returns the next array to persist, or null/undefined to skip the write.
// Resolves to true iff a write happened.
export function mutateMembers(spaceId, mutate) {
  const run = async () => {
    const entry = await spacesBee.get('space/' + spaceId)
    if (!entry) return false
    // Snapshot the keys BEFORE mutate runs: callers mutate `current` in place and return the same
    // array, so a before/after comparison of the arrays themselves would always come up empty.
    const before = new Set((entry.value.members || []).map((m) => m.publicKey))
    const current = (entry.value.members || []).map((m) => ({ ...m }))
    const next = mutate(current)
    if (!next) return false
    await spacesBee.put('space/' + spaceId, { ...entry.value, members: next })
    auditArrivals(spaceId, entry.value, next.filter((m) => !before.has(m.publicKey)))
    return true
  }
  const prev = memberWriteChains.get(spaceId) ?? Promise.resolve()
  const next = prev.then(run, run)
  // Swallow rejections on the tail so one failed write can't poison the chain.
  memberWriteChains.set(spaceId, next.then(() => {}, () => {}))
  return next
}

// The audit-worthy fact is the DURABLE roster gaining a member, never a handshake: connection
// state is rebuilt from scratch on every boot, so recording at handshake time re-reported every
// known member as a fresh arrival on each app start. This is the one funnel every path runs
// through — approval, handshake upsert, the join-time inviter pre-seed, and the replicated
// membership fold — so an arrival is recorded exactly once regardless of which lands first.
// Fire-and-forget: auditing must never delay or fail a membership write.
function auditArrivals(spaceId, space, added) {
  if (!added.length) return
  // While we are still pending we are not a member ourselves, so the roster we adopt during our
  // own join is the state we joined INTO — not a stream of arrivals. Our own `space.joined` row
  // already records that moment.
  if (space.status === 'pending') return
  Promise.all(added.map(async (m) => {
    // We approved them ourselves, so `membership.approved` already tells that story; a second
    // arrival row seconds later is noise.
    if (await hasOwnApproval(spaceId, m.publicKey)) return
    record('member.joined', {
      actor: { type: 'peer', key: m.publicKey, name: m.displayName || null },
      space: { id: spaceId, name: space.name ?? null },
      target: { kind: 'member', id: m.publicKey, name: m.displayName || null },
    })
  })).catch((err) => log.debug('arrival audit failed:', err.message))
}

// Serialized read-modify-write of a space's non-member fields (e.g. status),
// sharing the per-space chain so it can't lose-update against member writes.
export function mutateSpace(spaceId, mutate) {
  const run = async () => {
    const entry = await spacesBee.get('space/' + spaceId)
    if (!entry) return false
    const next = mutate({ ...entry.value })
    if (!next) return false
    await spacesBee.put('space/' + spaceId, next)
    return true
  }
  const prev = memberWriteChains.get(spaceId) ?? Promise.resolve()
  const next = prev.then(run, run)
  memberWriteChains.set(spaceId, next.then(() => {}, () => {}))
  return next
}

// Add a member, or merge fields into an existing one (matched by publicKey).
// null/undefined patch fields never overwrite an existing value, so a handshake
// (avatar:null) can't wipe an already-fetched avatar.
export function upsertMember(spaceId, patch, { create = true } = {}) {
  return mutateMembers(spaceId, (members) => {
    const idx = members.findIndex((m) => m.publicKey === patch.publicKey)
    if (idx === -1) {
      if (!create) return null
      const fresh = { publicKey: patch.publicKey, driveKey: null, displayName: 'Unknown', avatar: null }
      for (const [k, v] of Object.entries(patch)) if (v != null) fresh[k] = v
      members.push(fresh)
      return members
    }
    let changed = false
    const m = members[idx]
    for (const [k, v] of Object.entries(patch)) {
      if (v != null && m[k] !== v) { m[k] = v; changed = true }
    }
    return changed ? members : null
  })
}

// Remove a member by publicKey. Resolves true iff the member was present.
export function removeMember(spaceId, publicKey) {
  return mutateMembers(spaceId, (members) => {
    const next = members.filter((m) => m.publicKey !== publicKey)
    return next.length === members.length ? null : next
  })
}

export async function removeSpace(spaceId) {
  await clearAllLeftTombstones(spaceId)
  await spacesBee.del('space/' + spaceId)
  drives.delete(spaceId)
}

// Delete only the catalog record, keeping the drive in the in-memory map so a
// subsequent purgeSpaceDrive can still free its on-disk cores. Used early in leave
// so the space disappears durably even if a later purge step fails — a partial
// teardown then leaves reclaimable orphan cores, not a space stuck in the list.
export async function forgetSpaceRecord(spaceId) {
  await clearAllLeftTombstones(spaceId)
  await spacesBee.del('space/' + spaceId)
}

// Durable "leave in progress" marker, set as the FIRST durable step of space:leave — before
// clearOwnMembership. A quit anywhere in the teardown then leaves a record boot can finish,
// instead of markOwnMembership re-asserting active:true and resurrecting the space. A clean
// leave deletes the whole record (forgetSpaceRecord), so the marker only ever outlives a crash.
// A separate boolean, not a `status` value, so no existing status branch changes.
export function markSpaceLeavingDurable(spaceId) {
  return mutateSpace(spaceId, (space) => (space.leaving ? null : { ...space, leaving: true }))
}

// Idempotently finish a leave a prior process interrupted: re-assert the durable departure
// (covers a crash BEFORE the member del), drop the space's mount records + own share ads (the
// boot restart loops iterate the MOUNT stores, so a surviving record would re-arm a watcher or
// mirror against the space this pass is about to forget), then delete the local record. Reclaim
// of leftover cores/partials is left to the orphan/leftover sweeps, matching the teardown's own
// "record dropped up front, leftovers reclaimable" contract. Only the member del is a hard gate
// (a throw keeps the marker so the next boot retries it — co-member convergence depends on it);
// the mount/share steps are best-effort so one bad record can't strand the others or the forget.
export async function resumeInterruptedLeave(spaceId) {
  await clearOwnMembership(spaceId)
  try {
    for (const m of (await listOwnedMounts()).filter((x) => x.spaceId === spaceId)) {
      await deleteOwnedMount(spaceId, m.shareId)
    }
  } catch (err) {
    log.warn('resume leave: owned-mount cleanup failed:', spaceId, '-', err.message)
  }
  try {
    for (const s of await readOwnShares(spaceId)) {
      await tombstoneShare(spaceId, s.id)
    }
  } catch (err) {
    log.warn('resume leave: share tombstoning failed:', spaceId, '-', err.message)
  }
  try {
    for (const m of (await listForeignMounts()).filter((x) => x.spaceId === spaceId)) {
      await deleteForeignMount(spaceId, m.shareId)
    }
  } catch (err) {
    log.warn('resume leave: foreign-mount cleanup failed:', spaceId, '-', err.message)
  }
  await forgetSpaceRecord(spaceId)
}

// Durable, LOCAL-only leave tombstones: we record that we observed a peer leave a space so the
// member-view fold keeps subtracting it after a restart (the in-memory tombstone would be gone),
// including the creator/root where revokeApproval cannot help. Never replicated, so it can only
// ever suppress the leaver in OUR OWN fold — no cross-peer eviction. Stamped with the leaver's
// clock so a genuine rejoin (a strictly-later member/<S> ts) self-clears it via tombstoneActive.
const LEFT_TOMBSTONE_PREFIX = 'left/'
const leftRange = (spaceId) => ({ gte: LEFT_TOMBSTONE_PREFIX + spaceId + '/', lt: LEFT_TOMBSTONE_PREFIX + spaceId + '0' })
// Coerce to a positive finite number, so a corrupt stored value (negative/NaN/non-numeric) can
// never reach the tombstoneActive comparison as a negative — a negative would flip tombstoneActive
// false and actively re-admit the leaver. A garbage value collapses to a benign inert 0 (a member
// with any real ts>0 then reads as un-suppressed; the leave frame's own ts is validated positive at
// ingest, so this only guards genuine on-disk corruption).
const sanitizeLeaveTs = (v) => (Number.isFinite(v) && v > 0 ? v : 0)

// One tiny (~1 record) local, never-replicated tombstone per lifetime departure. Grow-only, cleared
// on the leaver's rejoin (dropTombstone) and on space deletion (clearAllLeftTombstones) — bounded in
// practice by the distinct members who ever left. Not count-pruned: evicting "the oldest" is unsafe
// (a tombstone is load-bearing exactly when its del hasn't replicated, and a long-gone unreachable
// leaver is the most likely to be un-replicated), and a per-leave range read to prune costs more
// than the tail it would trim.
export async function persistLeftTombstone(spaceId, key, leaveTs) {
  await spacesBee.put(LEFT_TOMBSTONE_PREFIX + spaceId + '/' + key, { leaveTs: sanitizeLeaveTs(leaveTs) })
}

// Non-throwing by contract (the caller ignores the result). A del that fails leaves the durable
// tombstone to re-seed the fold at the next boot, so it must not be silent.
export async function clearLeftTombstone(spaceId, key) {
  try { await spacesBee.del(LEFT_TOMBSTONE_PREFIX + spaceId + '/' + key) } catch (err) {
    log.warn('could not clear a leave tombstone — the member stays suppressed after the next restart:', spaceId, key.slice(0, 12) + '...', '-', err.message)
  }
}

export async function loadLeftTombstones(spaceId) {
  const out = new Map()
  for await (const entry of spacesBee.createReadStream(leftRange(spaceId))) {
    out.set(entry.key.slice((LEFT_TOMBSTONE_PREFIX + spaceId + '/').length), sanitizeLeaveTs(entry.value?.leaveTs))
  }
  return out
}

// ── pending outbound leaves ─────────────────────────────────────────────────────
// A leave broadcast that provably reached no member (nobody connected, or no ack)
// leaves the departure known only to the leaver's now-offline bee — co-members keep a
// ghost member forever. The marker survives the space-record purge (own key prefix in
// spaces-meta); the swarm re-announces the leave on new connections and boot re-joins
// the topic, until one co-member acks the durable apply and the marker clears.
const PENDING_LEAVE_PREFIX = 'pendingleave/'

export async function persistPendingLeave(spaceId, topic, ts) {
  await spacesBee.put(PENDING_LEAVE_PREFIX + spaceId, { topic, ts })
}

// Non-throwing by contract. A del that fails means the leave is re-announced at the next boot,
// which is harmless but must not be invisible.
export async function clearPendingLeave(spaceId) {
  try { await spacesBee.del(PENDING_LEAVE_PREFIX + spaceId) } catch (err) {
    log.warn('could not clear the pending-leave marker — the leave is re-announced at the next boot:', spaceId, '-', err.message)
  }
}

export async function listPendingLeaves() {
  const out = []
  for await (const entry of spacesBee.createReadStream({ gte: PENDING_LEAVE_PREFIX, lt: PENDING_LEAVE_PREFIX + '\xff' })) {
    out.push({
      spaceId: entry.key.slice(PENDING_LEAVE_PREFIX.length),
      topic: entry.value?.topic || null,
      ts: entry.value?.ts || 0,
    })
  }
  return out
}

async function clearAllLeftTombstones(spaceId) {
  const keys = []
  for await (const entry of spacesBee.createReadStream(leftRange(spaceId))) keys.push(entry.key)
  for (const k of keys) {
    try { await spacesBee.del(k) } catch (err) {
      log.warn('could not clear a leave tombstone during rejoin:', k, '-', err.message)
    }
  }
}

// Release a drive's core sessions ahead of purging its on-disk state. In identity
// mode the drive is built over the ROOT corestore (the `_db` Hyperdrive ctor path),
// so drive.close() would close that root and kill every other session — the
// "RocksDB session is closed" / "closing core" cascade that strands the leave before
// it deletes the space record. Close just this drive's own cores instead; the root
// stays open. Seed-mode drives (no master secret) own a namespaced corestore, so
// closing them is safe and still drops the (namespace, 'db') alias resolution.
async function releaseDriveForPurge(drive, blobs) {
  if (hasMasterSecret()) {
    try {
      if (blobs) await blobs.core.close()
      if (drive.db) await drive.db.close()
    } catch (err) {
      log.warn('drive core release during purge failed:', err.message)
    }
  } else {
    try { await drive.close() } catch (err) {
      log.warn('drive close during purge failed:', err.message)
    }
  }
}

export async function purgeSpaceDrive(spaceId, onProgress, { compact = true } = {}) {
  const drive = drives.get(spaceId)
  if (!drive) {
    log.warn('no drive found for space', spaceId)
    return
  }

  const cs = getStore()
  const db = cs.storage.db
  const emit = (phase) => { if (onProgress) onProgress(phase) }
  drives.delete(spaceId)

  try {
    await drive.ready()
    const metaDk = b4a.toString(drive.core.discoveryKey, 'hex')
    const blobs = await drive.getBlobs()
    const blobsDk = blobs ? b4a.toString(blobs.core.discoveryKey, 'hex') : null
    const driveNamespace = drive.corestore?.ns ? b4a.from(drive.corestore.ns) : null

    // Clear the drive's blocks before the header delete so RocksDB accounts blob
    // garbage; purgeCoreDk alone strands blob-separated values (garbage stays 0).
    try { await drive.clearAll() } catch (err) { log.warn('drive clearAll before purge failed:', err.message) }

    await releaseDriveForPurge(drive, blobs)

    emit('purgingLocalMeta')
    await purgeCoreDk(cs, db, metaDk)
    // Explicit-keypair drives (identity mode) open by keyPair, not name, so there
    // is no (namespace, 'db') alias to purge — and drive.corestore.ns is the root
    // namespace, which purgeAlias must not touch. Core data is still freed above.
    if (driveNamespace && !hasMasterSecret()) await purgeAlias(cs, driveNamespace, 'db')
    emit('purgingLocalBlobs')
    if (blobsDk) await purgeCoreDk(cs, db, blobsDk)

    emit('compactingLocalCache')
    // The cores are already tombstoned (purgeCoreDk above); the compaction only reclaims the
    // bytes. It is a full-range pass (scales with the WHOLE store, not this space), so callers that
    // leave can defer it to a single background pass instead of blocking on it per-drive.
    if (compact) {
      await db.compactRange(null, null, {
        blobGarbageCollectionPolicy: 1,
        blobGarbageCollectionAgeCutoff: 1.0,
        bottommostLevelCompaction: 2,
      })
    }
    log.info('purged local drive for space', spaceId)
  } catch (err) {
    log.warn('failed to purge drive for space', spaceId, err.message)
    // Best-effort release of the meta core's exclusive lock — never drive.close()
    // here, which would close the root corestore in identity mode.
    try { if (drive.db) await drive.db.close() } catch {}
  } finally {
    emit('finalizing')
    try { await db.flush() } catch (err) {
      log.warn('flush after purgeSpaceDrive failed:', err.message)
    }
  }
}

export async function purgeSpace(spaceId) {
  await clearAllLeftTombstones(spaceId)
  await spacesBee.del('space/' + spaceId)
  drives.delete(spaceId)
  try { await getStore().storage.db.flush() } catch (err) {
    log.warn('flush after purgeSpace failed:', err.message)
  }
}

// `downloadFolder` is tri-state: undefined leaves the override untouched, null clears it
// (the space falls back to the global download root), a string sets it. Routed through
// mutateSpace so it serializes against concurrent member writes.
export async function updateSpace(spaceId, name, icon, { downloadFolder } = {}) {
  let updated = null
  await mutateSpace(spaceId, (space) => {
    space.name = name
    space.icon = icon
    if (downloadFolder !== undefined) {
      if (downloadFolder === null) delete space.downloadFolder
      else space.downloadFolder = downloadFolder
    }
    updated = space
    return space
  })
  return updated ? { spaceId, ...updated } : null
}

// Routed through mutateSpace for the same reason as updateSpace: a raw get/put here would
// not serialize against it, and a star clicked while a space:update is still validating a
// download folder (statSync + write probe + a mount scan) would write back the record it read
// BEFORE that update landed — silently dropping the folder the user just chose.
export async function toggleFavorite(spaceId) {
  let updated = null
  await mutateSpace(spaceId, (space) => {
    space.favorite = !space.favorite
    updated = space
    return space
  })
  return updated ? { spaceId, ...updated } : null
}

export function getDrive(spaceId) {
  return drives.get(spaceId)
}

// Open one space's drive. Split out so boot can inject a failing opener in tests.
async function openSpaceDrive(space) {
  const sck = getSpaceContentKey(space.spaceId, space)
  const drive = createDrive(makeDriveName(space.spaceId, space.driveSuffix), { encryptionKey: sck })
  await drive.ready()
  return drive
}

export async function loadDrives({ openDrive = openSpaceDrive } = {}) {
  const spaces = await listSpaces()
  let hadFailure = false
  for (const space of spaces) {
    // A leaving space's drive must not come back up either: loadDrives runs before the boot
    // completion pass, so the marker is the only thing keeping it down.
    if (space.status === 'pending' || space.leaving) continue
    let drive
    try {
      drive = await openDrive(space)
    } catch (err) {
      hadFailure = true
      if (isStorageInconsistency(err)) {
        // The core's own tree cannot back its length: no retry will open this drive. Drop the
        // record; the leftover sweep can reclaim its cores.
        log.error('drive storage inconsistent for', space.spaceId, '-', err.message, '- dropping space record')
        try { await spacesBee.del('space/' + space.spaceId) } catch (delErr) {
          log.warn('could not drop the space record:', space.spaceId, '-', delErr.message)
        }
      } else {
        // Anything else may be transient (a lock still held by a dying instance, disk pressure,
        // a half-written core). Keep the space, mark it, and let the next boot retry: deleting
        // the record costs the user the space outright, which a transient fault must not do.
        log.error('drive load failed for', space.spaceId, '-', err.message, '- keeping the space record for retry')
        await mutateSpace(space.spaceId, (s) => ({ ...s, driveLoadError: { message: err.message, at: Date.now() } }))
          .catch((mErr) => log.warn('could not mark the drive-load failure:', space.spaceId, '-', mErr.message))
      }
      continue
    }
    drives.set(space.spaceId, drive)
    if (space.driveLoadError) {
      await mutateSpace(space.spaceId, (s) => { const next = { ...s }; delete next.driveLoadError; return next })
        .catch((mErr) => log.warn('could not clear the drive-load marker:', space.spaceId, '-', mErr.message))
    }
    // Idempotent backfills, re-run every boot. Not part of loading the drive: a profile or
    // catalog write that fails must not cost the space its record.
    try {
      if (space.schemaVersion === 2) await markSpaceDriveKey(space.spaceId, b4a.toString(drive.key, 'hex'))
      await publishLooseCatalogKey(space.spaceId, space)
    } catch (err) {
      log.warn('post-load backfill failed for', space.spaceId, '-', err.message)
    }
  }
  return { hadFailure }
}

// The live bee, for tests that need a write to fail. Not for production callers.
export function _spacesBeeForTests() {
  return spacesBee
}

// Pending join requests for v2 spaces, in-memory and per-space. A request is a peer
// that connected/handshook but isn't yet an approved member; it surfaces to the UI
// and clears on approve/deny.
const pendingRequests = new Map()

// Derived (replicated, converged) pending requests, computed by the member registry's fold over
// members' request/denied records. Authoritative for the UI; `pendingRequests` above stays as a
// live, this-peer cache that fills the gap before the first fold and carries the joiner's
// driveKey/socket for the grant path (getJoinRequestDriveKey / sendMembershipGrant).
const derivedRequests = new Map()

export function setDerivedRequests(spaceId, map) {
  if (!map || map.size === 0) derivedRequests.delete(spaceId)
  else derivedRequests.set(spaceId, new Map(map))
}

// Returns whether the entry is new or materially changed, so a re-announced (heartbeat)
// request doesn't re-fire the approval banner on every repeat.
export function recordJoinRequest(spaceId, profileKey, displayName, avatar = null, driveKey = null) {
  if (!pendingRequests.has(spaceId)) pendingRequests.set(spaceId, new Map())
  const prev = pendingRequests.get(spaceId).get(profileKey)
  const next = {
    displayName: displayName || 'Unknown',
    avatar: avatar || prev?.avatar || null,
    driveKey: driveKey || prev?.driveKey || null,
    ts: Date.now(),
  }
  pendingRequests.get(spaceId).set(profileKey, next)
  return !prev || prev.displayName !== next.displayName || prev.avatar !== next.avatar || prev.driveKey !== next.driveKey
}

// The converged set wins; the live cache only fills in an arrival not yet folded (dedup by key).
// A live entry carrying a driveKey is a materialized member converging (recorded by the handshake
// gate), not a join request — never surface it as approvable, even if it also lingers in the
// (replication-lagged) derived set. Genuine joiners have no driveKey.
export function listJoinRequests(spaceId) {
  const out = new Map()
  const live = pendingRequests.get(spaceId)
  const isConvergingMember = (k) => !!live?.get(k)?.driveKey
  const derived = derivedRequests.get(spaceId)
  if (derived) for (const [k, v] of derived) if (!isConvergingMember(k)) out.set(k, { publicKey: k, displayName: v.displayName, avatar: v.avatar, ts: v.ts })
  if (live) for (const [k, v] of live) if (!out.has(k) && !v.driveKey) out.set(k, { publicKey: k, displayName: v.displayName, avatar: v.avatar, ts: v.ts })
  return [...out.values()]
}

// Pending requests for the UI, excluding anyone already in the roster: a member can never also be
// "pending". Guards against a stale live/derived entry for a peer admitted via the handshake gate
// (which clears only the live cache) or whose approval was learned from records before the gate ran —
// the source of an owner seeing an already-joined member stuck as a pending approval.
export function listPendingRequests(spaceId, memberKeys = null) {
  const reqs = listJoinRequests(spaceId)
  if (!memberKeys || !memberKeys.size) return reqs
  return reqs.filter((r) => !memberKeys.has(r.publicKey))
}

export function getJoinRequestDriveKey(spaceId, profileKey) {
  return pendingRequests.get(spaceId)?.get(profileKey)?.driveKey || null
}

export function clearJoinRequest(spaceId, profileKey) {
  return pendingRequests.get(spaceId)?.delete(profileKey) || false
}

// Approve a joiner: write the authored approval record, mark them an approved
// member, and drop any pending request.
export async function recordApproval(spaceId, joinerKey) {
  await markApproval(spaceId, joinerKey)
  await upsertMember(spaceId, { publicKey: joinerKey, status: 'approved' })
  await clearRequest(spaceId, joinerKey)
  clearJoinRequest(spaceId, joinerKey)
}

// Create our own writable space drive, encrypted from block 0 with the granted SCK,
// and flip the space out of the pending state.
export async function materializeOwnDrive(spaceId, sck) {
  await putContentKey(spaceId, sck)
  const space = await getSpace(spaceId)
  if (!space) return null
  if (!drives.has(spaceId)) {
    const drive = createDrive(makeDriveName(spaceId, space.driveSuffix), { encryptionKey: sck })
    await drive.ready()
    drives.set(spaceId, drive)
  }
  // Publish our drive key so co-members (incl. ones who only derive us from records) can open it.
  await markSpaceDriveKey(spaceId, b4a.toString(drives.get(spaceId).key, 'hex'))
  await publishLooseCatalogKey(spaceId, space)
  await mutateSpace(spaceId, (s) => ({ ...s, status: 'approved' }))
  return drives.get(spaceId)
}

// Backfill the OR-Set root for v2 spaces whose stored record predates `creatorKey`.
// A space I created is identifiable by `sckDerivable` (set only by createSpace, never
// by a join), so I am its root — stamp myself. Joined spaces whose creatorKey is
// unknown (their invite carried no `c` hint) are deliberately left untouched: the
// membership fold falls back to seeding from the known member set for them until a
// fresh invite or an authenticated handshake assertion supplies the real creator.
// Idempotent; returns the count stamped.
export async function backfillSelfCreatedCreatorKey() {
  const me = getLocalPublicKeyHex()
  if (!me) return 0
  let stamped = 0
  for (const space of await listSpaces()) {
    if (space.creatorKey || !space.sckDerivable) continue
    const ok = await mutateSpace(space.spaceId, (s) => ({ ...s, creatorKey: me }))
    if (ok) stamped += 1
  }
  if (stamped) log.info('backfilled creatorKey on', stamped, 'self-created space(s)')
  return stamped
}

// Authoritatively pin the now-authenticated OR-Set root and clear the provisional
// flag. The caller (onGrant / the handshake cross-check) has already verified the asserting
// peer's identity binding, so this root is no longer a bearer hint. creatorMigrated stamps the
// space past the one-shot migration so no later boot can downgrade this pin to provisional.
export function pinCreatorKey(spaceId, root) {
  return mutateSpace(spaceId, (s) => ({ ...s, creatorKey: root, creatorUnverified: false, creatorDivergence: false, creatorMigrated: true }))
}

// A confirmed creator-root conflict: an authenticated peer asserted a different root than our
// authenticated pin (potential roster split-brain / impersonation). Persist it durably so the UI
// surfaces a level-triggered warning that survives a missed event; the pin is left untouched (we
// refuse the assertion). Sticky while the conflict is live (the divergent peer's next assertion
// re-refuses); cleared by clearCreatorDivergence when an authenticated peer re-asserts the pin,
// or by pinCreatorKey when the root is re-authenticated.
export function markCreatorDivergence(spaceId) {
  return mutateSpace(spaceId, (s) => ({ ...s, creatorDivergence: true }))
}

// An authenticated peer re-asserted the pinned root (a `noop` reconcile decision) — the
// conflict is no longer live, so the divergence warning clears. Level-triggered lifecycle:
// re-derived per assertion, never latched.
export function clearCreatorDivergence(spaceId) {
  return mutateSpace(spaceId, (s) => (s.creatorDivergence ? { ...s, creatorDivergence: false } : s))
}

// A v2 space we JOINED whose creatorKey is only TOFU-pinned (trust-on-first-use — it came
// from a bearer invite, not an authenticated assertion) is marked unverified, arming the
// handshake divergence cross-check and letting the UI flag an unverified owner. It does NOT
// self-heal through onGrant — an approved space never re-enters the grant flow — so the
// authenticated re-confirmation comes from the handshake `creator` assertion. Self-created
// (sckDerivable) and v1 spaces are untouched. One-shot per space (creatorMigrated stamp):
// re-flagging on every boot would downgrade an authenticated pin back to provisional,
// re-opening the adopt path to a divergent root after any restart. Returns the count flagged.
export async function flagUnverifiedJoinedCreators() {
  let flagged = 0
  for (const space of await listSpaces()) {
    if (space.schemaVersion !== 2 || space.sckDerivable) continue
    if (space.creatorMigrated) continue
    if (!space.creatorKey || space.creatorUnverified) {
      // Nothing to flag, but stamp it so a later authenticated pin is never re-armed either.
      await mutateSpace(space.spaceId, (s) => ({ ...s, creatorMigrated: true }))
      continue
    }
    if (await mutateSpace(space.spaceId, (s) => ({ ...s, creatorUnverified: true, creatorMigrated: true }))) flagged += 1
  }
  if (flagged) log.info('flagged', flagged, 'joined space(s) creatorKey unverified')
  return flagged
}

export class SpacesBee extends Subsystem {
  async _open() { await initSpaces() }

  async _close() {
    const bee = spacesBee
    spacesBee = undefined
    // This-session state: a live join request is a peer that handshook during THIS run. Left
    // behind it re-surfaces as a pending approval after an in-process restart.
    pendingRequests.clear()
    derivedRequests.clear()
    memberWriteChains.clear()
    await bee?.close()
  }
}

// Split from SpacesBee because the audit log, the serve ledger and the catalog cache all start
// between the space record opening and the drives loading.
export class SpaceDrives extends Subsystem {
  async _open() { this.load = await loadDrives() }

  async _close() {
    const open = [...drives.values()]
    drives.clear()
    await Promise.allSettled(open.map((drive) => drive.close()))
  }
}
