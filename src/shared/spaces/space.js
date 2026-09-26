// The `spaces-meta` bee: this peer's record of every space it belongs to, and the serialized
// writers that mutate one. Three key namespaces live in the bee, the latter two written by
// leave-records.js:
//   space/<spaceId>            the space record (below)
//   left/<spaceId>/<memberKey> a leave tombstone: { leaveTs }
//   pendingleave/<spaceId>     an interrupted leave boot must finish: { topic, ts }
//
// A space record is written whole by createSpace and joinSpace and patched through mutateSpace
// thereafter. Seven fields are always present — name, icon, topic, created, members, driveSuffix,
// schemaVersion. The rest are latches, each owned by one writer: `status: 'pending'` until the
// grant arrives, `epoch` (the SCK epoch this peer holds; absent reads as 0), `createdBySelf`,
// `sckDerivable` and `creatorKey` stamped at creation (creatorKey may instead be pre-seeded from
// an invite and marked `creatorUnverified` until onGrant pins it), `inviteId` from the invite we
// joined through, `leaving` while a leave runs, `left`/`joined`/`updated` as timestamps,
// `favorite` and `downloadFolder` as user choices, and `creatorDivergence`, `creatorMigrated` and
// `legacyWarning` as diagnoses a later pass records.
import { createLocalBee, storeEpoch, deriveSpaceContentKey } from '../core/store.js'
import { getContentKeyForEpoch } from './space-keys.js'
import { hasOwnApproval } from './profile.js'
import { resetJoinRequests } from './join-requests.js'
import { Subsystem } from '../core/subsystem.js'
import { recordResolved } from '../audit/audit-log.js'
import { prefixRange } from '../core/bee-keys.js'
import { createRecordWriter } from '../core/bee-writer.js'
import { createLogger } from '../core/logger.js'
import { TARGET_KIND } from '../contract/audit-kinds.js'
import { UNKNOWN_DISPLAY_NAME } from '../contract/limits.js'
import { peerActor, spaceRef, targetRef } from '../audit/audit-record.js'
/** @import { SpaceRecord } from '../contract/responses.js' */

const log = createLogger('spaces')

let spacesBee
let spacesStore = -1

/** @internal production opens the spaces bee through this file's own _open() */
export async function initSpaces() {
  if (spacesBee && spacesStore === storeEpoch() && !spacesBee.core.closed) return
  spacesStore = storeEpoch()
  spacesBee = createLocalBee('spaces-meta')
  await spacesBee.ready()
}

// The open bee, for the modules that own the other two key namespaces. Throws rather than
// handing back a closed handle, so a caller racing the subsystem's stop fails where it happened.
export function spacesMeta() {
  if (!spacesBee) throw new Error('the spaces bee is not open')
  return spacesBee
}

// The SCK epoch this peer holds for the space. A record written before the field existed is at
// epoch 0, the only epoch there has ever been.
export function spaceEpoch(space) {
  return Number.isInteger(space?.epoch) ? space.epoch : 0
}

// Whether this peer created the space. `sckDerivable` carries the same meaning on a record that
// predates `createdBySelf`; this is the one place that reads it.
export function isCreatedBySelf(space) {
  return space.createdBySelf ?? !!space.sckDerivable
}

// Only the epoch-0 key can be re-derived from M, and only by the creator: once a space rotates,
// even the creator holds the current key nowhere but the vault.
function epochZeroDerivable(space, epoch) {
  return epoch === 0 && isCreatedBySelf(space)
}

// The key for one epoch: the vault, else the derivation for a creator's epoch 0. A peer catalog
// published under an earlier epoch reads through this with the record's epoch.
export function getSpaceContentKeyForEpoch(spaceId, space, epoch) {
  if (!space) return null
  return getContentKeyForEpoch(spaceId, epoch)
    || (epochZeroDerivable(space, epoch) ? deriveSpaceContentKey(spaceId) : null)
}

// Per-space content key (SCK) at the space's CURRENT epoch — what every own-core open wants.
export function getSpaceContentKey(spaceId, space) {
  return getSpaceContentKeyForEpoch(spaceId, space, spaceEpoch(space))
}

// A space created before v1.7.0, when every space became SCK-encrypted. There is no upgrade
// path — v2 needs the CREATOR to mint an SCK and re-grant every member, a coordinated multi-peer
// re-key rather than a local migration — so such a record is surfaced as unsupported instead of
// half-working: catalog naming, own-catalog open and the admit gate all assume v2. This is the
// only schemaVersion read left in the data layer.
export function isLegacySpace(space) {
  return !!space && space.schemaVersion !== 2
}

// The refusal every legacy-space gate throws. The renderer translates SPACE_UNSUPPORTED and never
// reads this text; it is here so the three worker-side gates cannot word it three ways.
export const LEGACY_SPACE_MESSAGE = 'This space was created by an older version of Mirall and can no longer be used'

export async function listSpaces() {
  const spaces = []
  for await (const entry of spacesBee.createReadStream(prefixRange('space/'))) {
    const spaceId = entry.key.replace('space/', '')
    spaces.push({ spaceId, ...entry.value })
  }
  return spaces
}

/**
 * The stored record: the wire shape plus the fields only the worker keeps.
 * @typedef {SpaceRecord & { creatorKey?: string, creatorUnverified?: boolean, creatorDivergence?: boolean, leaving?: boolean }} StoredSpace
 */

/** @param {string} spaceId @returns {Promise<StoredSpace | null>} */
export async function getSpace(spaceId) {
  const entry = await spacesBee.get('space/' + spaceId)
  return entry ? { spaceId, ...entry.value } : null
}

const spaceKey = (spaceId) => 'space/' + spaceId

// Every write of a space record goes through one record writer. A peer joining a space that already
// has 2+ members fires several handshakes at once, and leave frames and reconcile prunes land
// concurrently with them: the per-record lock orders them so each write sees the previous one, and
// cas turns a write that bypassed the lock into a retry rather than a clobbered roster.
const records = createRecordWriter({ bee: () => spacesBee, log })

// Writes a whole record. Only the two paths that mint one — create and join — write this way;
// every later change goes through mutateSpace or mutateMembers.
export function putSpaceRecord(spaceId, space) {
  return records.put(spaceKey(spaceId), space)
}

export function deleteSpaceRecord(spaceId) {
  return records.del(spaceKey(spaceId))
}

// `mutate(members)` gets a copy of the current member list and returns the next array to persist,
// or null/undefined to skip the write. Resolves to true iff the list changed and was written.
export async function mutateMembers(spaceId, mutate) {
  const out = await records.mutateWithOutcome(spaceKey(spaceId), (space) => {
    const next = mutate(space.members || [])
    return next ? { ...space, members: next } : null
  })
  if (!out?.written) return false
  const before = new Set((out.previous.members || []).map((m) => m.publicKey))
  auditArrivals(spaceId, out.previous, out.value.members.filter((m) => !before.has(m.publicKey)))
  return true
}

// Read-modify-write of a space's non-member fields (e.g. status). Resolves to the record as stored
// after the call — written, or unchanged when `mutate` returned an equal record — or null when the
// space is gone or `mutate` declined.
export async function mutateSpace(spaceId, mutate) {
  const out = await records.mutateWithOutcome(spaceKey(spaceId), mutate)
  return out ? { spaceId, ...out.value } : null
}

// The audit-worthy fact is the DURABLE roster gaining a member, never a handshake: connection state
// is rebuilt on every boot, so a handshake-time row would re-report every known member as a fresh
// arrival at each start. This is the one funnel every path runs through — approval, handshake
// upsert, the join-time inviter pre-seed, the replicated membership fold — so an arrival is recorded
// exactly once whichever lands first. Fire-and-forget: auditing must never delay or fail a write.
function auditArrivals(spaceId, space, added) {
  if (!added.length) return
  // While we are still pending we are not a member ourselves, so the roster we adopt during our
  // own join is the state we joined INTO — not a stream of arrivals. Our own `space.joined` row
  // already records that moment.
  if (space.status === 'pending') return
  const ref = spaceRef(spaceId, space.name ?? null)
  const context = { space: spaceId.slice(0, 12) }
  for (const m of added) {
    recordResolved('member.joined', async () => {
      // We approved them ourselves, so `membership.approved` already tells that story; a second
      // arrival row seconds later is noise.
      if (await hasOwnApproval(spaceId, m.publicKey)) return null
      return {
        actor: peerActor(m.publicKey, m.displayName || null),
        space: ref,
        target: targetRef(TARGET_KIND.MEMBER, m.publicKey, m.displayName || null),
      }
    }, { context })
  }
}

// Add a member, or merge fields into an existing one (matched by publicKey).
// null/undefined patch fields never overwrite an existing value, so a handshake
// (avatar:null) can't wipe an already-fetched avatar.
export function upsertMember(spaceId, patch, { create = true } = {}) {
  return mutateMembers(spaceId, (members) => {
    const idx = members.findIndex((m) => m.publicKey === patch.publicKey)
    if (idx === -1) {
      if (!create) return null
      const fresh = { publicKey: patch.publicKey, displayName: UNKNOWN_DISPLAY_NAME, avatar: null }
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

// A partial update: an absent name or icon leaves the stored one alone. `downloadFolder` is
// tri-state: undefined leaves the override untouched, null clears it (the space falls back to the
// global download root), a string sets it. Routed through mutateSpace so it serializes against
// concurrent member writes.
/**
 * @param {string} spaceId
 * @param {string | null | undefined} name
 * @param {string | null | undefined} icon
 * @param {{ downloadFolder?: string | null }} [opts]
 * @returns {Promise<StoredSpace | null>}
 */
export function updateSpace(spaceId, name, icon, { downloadFolder } = {}) {
  return mutateSpace(spaceId, (space) => {
    if (name != null) space.name = name
    if (icon != null) space.icon = icon
    if (downloadFolder !== undefined) {
      if (downloadFolder === null) delete space.downloadFolder
      else space.downloadFolder = downloadFolder
    }
    return space
  })
}

// Serialized with updateSpace via mutateSpace: a raw get/put would write back a record read BEFORE a
// concurrent space:update landed, silently dropping the download folder the user just chose.
/** @param {string} spaceId @returns {Promise<StoredSpace | null>} */
export function toggleFavorite(spaceId) {
  return mutateSpace(spaceId, (space) => {
    space.favorite = !space.favorite
    return space
  })
}

// The live bee, for tests that need a write to fail. Not for production callers.
/** @internal */
export function _spacesBeeForTests() {
  return spacesBee
}

export class SpacesBee extends Subsystem {
  async _open() { await initSpaces() }

  async _close() {
    const bee = spacesBee
    spacesBee = undefined
    // This-session state: a live join request is a peer that handshook during THIS run. Left
    // behind it re-surfaces as a pending approval after an in-process restart.
    resetJoinRequests()
    await bee?.close()
  }
}
