// The user's replicated profile bee: public identity (displayName/avatar), the membership
// manifest (member/, approved/, invite/, request/, denied/ — the records peers fold
// membership from), and per-space key announcements (drive/, loosecat/, loosecatEnc/).
// Also the bounded readers of PEERS' profile bees: every remote read is deadline-capped
// so an offline or not-yet-replicated peer degrades to null/empty instead of hanging.
import Hyperbee from 'hyperbee'
import { createBee, getStore, storeEpoch } from '../core/store.js'
import { withReadTimeout, peerReadTimeoutMs, interactiveReadTimeoutMs } from '../core/with-timeout.js'
import { mapLimit } from '../core/concurrency.js'
import { getResourceCaps, getCaptureMemberRecordMs } from '../core/runtime-config.js'
import { clampDisplayName, sanitizeAvatar } from '../identity-limits.js'
import { voucheesToAdopt } from './member-set.js'
import b4a from 'b4a'
import { createLogger } from '../core/logger.js'
import { Subsystem } from '../core/subsystem.js'

const log = createLogger('membership')

export const CAP_MEMBERSHIP_MANIFEST = 'caps/membership-manifest'

let profileBee
let profileStore = -1

export async function initProfile() {
  if (profileBee && profileStore === storeEpoch() && !profileBee.core.closed) return
  profileStore = storeEpoch()
  profileBee = createBee('profile')
  await profileBee.ready()
}

export async function getProfile() {
  const displayName = await profileBee.get('displayName')
  if (!displayName) return null
  const avatar = await profileBee.get('avatar')
  const publicKey = b4a.toString(profileBee.core.key, 'hex')
  return {
    displayName: displayName.value,
    avatar: avatar?.value || null,
    publicKey,
  }
}

export async function setProfile({ displayName, avatar }) {
  await profileBee.put('displayName', clampDisplayName(displayName))
  if (avatar !== undefined) {
    await profileBee.put('avatar', sanitizeAvatar(avatar, getResourceCaps().avatarMaxBytes))
  }
  await profileBee.put('publicKey', b4a.toString(profileBee.core.key, 'hex'))
}

export class ProfileBee extends Subsystem {
  async _open() { await initProfile() }

  async _close() {
    const bee = profileBee
    profileBee = undefined
    await bee?.close()
  }
}

export function getProfileKey() {
  return profileBee.core.key
}

export function getLocalPublicKeyHex() {
  if (!profileBee) return null
  return b4a.toString(profileBee.core.key, 'hex')
}

export function getProfileBee() {
  return profileBee
}

// The profile core's signer (secret/public keypair + manifest namespace). profileKey is
// the manifest hash, so a verifier needs the signer key + namespace to bind a handshake
// signature back to profileKey (the handshake identity binding).
export function getIdentitySigner() {
  const core = profileBee?.core
  const kp = core?.keyPair
  const namespace = core?.manifest?.signers?.[0]?.namespace
  if (!kp?.secretKey || !kp?.publicKey || !namespace) return null
  return { secretKey: kp.secretKey, publicKey: kp.publicKey, namespace }
}

// `timeoutMs` is a SESSION-level hypercore timeout: every block read under this session (and the
// snapshot sessions hyperbee opens per get) settles with REQUEST_TIMEOUT instead of waiting for a
// block that may never arrive — so an abandoned read cannot pin the core through a hung batch.
// 0 keeps hypercore's default (wait forever), which the long-lived holders want.
// `active` marks the session as one that wants replication. An inactive session does not count
// toward the core's replicator activity, so the core is not force-attached to every open muxer
// (corestore's per-connection attach pass skips it). Defaults TRUE so every syncing read behaves
// exactly as before: a read that needs blocks and opens inactive would simply never get them.
export function openProfileBee(publicKeyBuffer, { timeoutMs = 0, active = true } = {}) {
  const store = getStore()
  const opts = { key: publicKeyBuffer, ...(timeoutMs ? { timeout: timeoutMs } : {}), ...(active ? {} : { active: false }) }
  const core = (timeoutMs || !active) ? store.get(opts) : store.get(publicKeyBuffer)
  return new Hyperbee(core, {
    keyEncoding: 'utf-8',
    valueEncoding: 'json',
  })
}

export async function ensureMembershipManifestCap() {
  const entry = await profileBee.get(CAP_MEMBERSHIP_MANIFEST)
  if (!entry?.value) {
    await profileBee.put(CAP_MEMBERSHIP_MANIFEST, true)
  }
}

export async function markOwnMembership(spaceId, { refresh = false } = {}) {
  await ensureMembershipManifestCap()
  // Boot backfill (refresh=false): if we're already an active member, keep the existing record (and
  // its ts) rather than re-stamping a fresh Date.now() — a bump would flip every co-member's
  // viewSignature and fan a redundant reconcile out to them on every restart.
  // (Re)join (refresh=true): force a strictly-later ts even over a lingering record, so a co-member
  // that tombstoned us self-clears (tombstoneActive) on our return — covers the case where the prior
  // leave's clearOwnMembership was swallowed and left a stale-active record behind.
  if (!refresh) {
    const existing = await profileBee.get('member/' + spaceId)
    if (existing?.value?.active) return
  }
  await profileBee.put('member/' + spaceId, { active: true, ts: Date.now() })
}

// Record the departure as a value rather than deleting the key: the record's own seq is the log
// position of the departure, which is what lets a reader tell a vouch authored while a member from
// one authored after leaving. A delete erases that position. Readers fold a present-but-inactive
// record and an absent one to the same `active: false`, so this stays compatible both ways.
export async function clearOwnMembership(spaceId) {
  await ensureMembershipManifestCap()
  await profileBee.put('member/' + spaceId, { active: false, ts: Date.now() })
}

// Tri-state read of a peer's own `member/<S>.active` manifest (true / false=left /
// null=no manifest). The canonical manifest reader; the membership fold reads the same
// records via readMembershipRecord.
export async function readPeerMembership(profileKeyHex, spaceId) {
  try {
    // Whole read is bounded: direct reads usually resolve in ~one RTT, so this doesn't
    // slow the happy path; the deadline matters when the manifest blocks are advertised
    // but never replicated (offline peer) — the post-update bee.get calls would otherwise
    // wait forever.
    return await withReadTimeout(loadPeerMembership(profileKeyHex, spaceId), peerReadTimeoutMs(), null)
  } catch {
    return null
  }
}

function loadPeerMembership(profileKeyHex, spaceId) {
  return withPeerBee(profileKeyHex, async (bee) => {

    const cap = await bee.get(CAP_MEMBERSHIP_MANIFEST)
    if (!cap?.value) return null
    const entry = await bee.get('member/' + spaceId)
    return entry ? !!entry.value?.active : false
  })
}

// Authored approval record in our own profile bee: the approver vouches that
// joinerKeyHex was let into spaceId. Authorship of the append-only bee is the
// attribution (there is no detached signature primitive); readable by any peer.
export async function markApproval(spaceId, joinerKeyHex) {
  await ensureMembershipManifestCap()
  await profileBee.put('approved/' + spaceId + '/' + joinerKeyHex, { ts: Date.now() })
}

// Revoke our approval of joinerKeyHex (del flips hasOwnApproval/readPeerApproval to false), so the
// OR-Set fold stops counting our vouch and a departed member must be re-approved to rejoin.
export async function revokeApproval(spaceId, joinerKeyHex) {
  if (!profileBee) return
  await profileBee.del('approved/' + spaceId + '/' + joinerKeyHex)
}

// Take over a departing peer's vouchees so revoking our vouch for it doesn't strand the subtree it
// alone vouched for. MUST run before revokeApproval: once the leaver is unauthorized the fold stops
// walking its bee, so its approvals may never be readable again. Returns false when the record is
// unreadable — the caller then leaves the whole departure unapplied so a later fold retries, and
// never revokes on its own.
export async function adoptVouchees(spaceId, leaverKeyHex) {
  const rec = await readMembershipRecord(leaverKeyHex, spaceId)
  if (!rec) return false
  for (const vouchee of voucheesToAdopt(rec.approvals, getLocalPublicKeyHex(), leaverKeyHex)) {
    if (await hasOwnApproval(spaceId, vouchee)) continue
    await markApproval(spaceId, vouchee)
    log.info('adopted vouchee from a departing peer:', vouchee.slice(0, 12) + '...', '→', spaceId)
  }
  return true
}

// True iff WE authored an approval for joinerKeyHex in this space (our own bee — a local read).
// The admission gate consults this so a peer the owner itself approved is admitted even before
// the fold re-derives them: isApprovedByPeers only checks OTHER members' bees, never our own.
export async function hasOwnApproval(spaceId, joinerKeyHex) {
  if (!profileBee) return false
  const entry = await profileBee.get('approved/' + spaceId + '/' + joinerKeyHex)
  return !!entry
}

export async function readPeerApproval(approverProfileKeyHex, spaceId, joinerKeyHex) {
  try {
    return await withReadTimeout(
      loadPeerApproval(approverProfileKeyHex, spaceId, joinerKeyHex),
      peerReadTimeoutMs(),
      null,
    )
  } catch {
    return null
  }
}

function loadPeerApproval(approverProfileKeyHex, spaceId, joinerKeyHex) {
  return withPeerBee(approverProfileKeyHex, async (bee) => {

    const cap = await bee.get(CAP_MEMBERSHIP_MANIFEST)
    if (!cap?.value) return null
    const entry = await bee.get('approved/' + spaceId + '/' + joinerKeyHex)
    return !!entry
  })
}

// Per-link invite record authored in our own (replicated) profile bee, so any member can resolve a
// join through this link. Reusable until expiry — not consumed on use.
export async function markInvite(spaceId, inviteId, { autoApprove = false, expiresAt = null } = {}) {
  await ensureMembershipManifestCap()
  await profileBee.put('invite/' + spaceId + '/' + inviteId, {
    autoApprove: !!autoApprove,
    expiresAt: Number.isInteger(expiresAt) ? expiresAt : null,
    created: Date.now(),
  })
}

// Revoke a link we minted (we can only del our own bee). The tombstone replicates to co-members.
export async function revokeInvite(spaceId, inviteId) {
  if (!profileBee || !inviteId) return false
  return profileBee.del('invite/' + spaceId + '/' + inviteId)
}

export async function readOwnInvite(spaceId, inviteId) {
  if (!profileBee || !inviteId) return null
  const entry = await profileBee.get('invite/' + spaceId + '/' + inviteId)
  return entry?.value || null
}

// { resolved: true, value } = the LIVE bee answered; value null means the record is
// genuinely absent there (revoked or never minted) — authoritative, so callers must NOT
// fall back to a stale snapshot for it. Bare null = the read FAILED (timeout / no serving
// peer) and says nothing about the record.
export async function readPeerInvite(profileKeyHex, spaceId, inviteId) {
  try {
    return await withReadTimeout(loadPeerInvite(profileKeyHex, spaceId, inviteId), peerReadTimeoutMs(), null)
  } catch {
    return null
  }
}

function loadPeerInvite(profileKeyHex, spaceId, inviteId) {
  return withPeerBee(profileKeyHex, async (bee) => {

    const cap = await bee.get(CAP_MEMBERSHIP_MANIFEST)
    if (!cap?.value) return { resolved: true, value: null }
    const entry = await bee.get('invite/' + spaceId + '/' + inviteId)
    return { resolved: true, value: entry?.value || null }
  })
}

// Local-only read at the highest CONTIGUOUS snapshot we hold of the peer's bee: a
// checkout at contiguousLength only resolves through blocks we already have, so it
// works with the peer offline. A revocation (del) that replicated into the prefix is
// honored — the snapshot read then finds nothing. The timeout is a backstop only;
// no block fetch should occur.
export async function readPeerInviteSnapshot(profileKeyHex, spaceId, inviteId) {
  let bee
  let snap
  try {
    bee = openProfileBee(b4a.from(profileKeyHex, 'hex'))
    await bee.ready()
    const contig = bee.core.contiguousLength
    if (contig < 1) return null
    snap = bee.checkout(contig)
    const read = (async () => {
      const cap = await snap.get(CAP_MEMBERSHIP_MANIFEST)
      if (!cap?.value) return null
      const entry = await snap.get('invite/' + spaceId + '/' + inviteId)
      return entry?.value || null
    })()
    return await withReadTimeout(read, interactiveReadTimeoutMs(), null)
  } catch {
    return null
  } finally {
    if (snap) await snap.close().catch(() => {})
    if (bee) await bee.close().catch(() => {})
  }
}

export async function listOwnInvites(spaceId) {
  if (!profileBee) return []
  const prefix = 'invite/' + spaceId + '/'
  const limit = getResourceCaps().invitesPerMember
  const out = []
  for await (const entry of profileBee.createReadStream({ gte: prefix, lt: prefix.slice(0, -1) + '0' }, limit ? { limit } : undefined)) {
    out.push({ inviteId: entry.key.slice(prefix.length), ...entry.value })
  }
  return out
}

// Prune our own expired links for a space; returns the count removed.
export async function sweepExpiredInvites(spaceId, now = Date.now()) {
  let removed = 0
  for (const rec of await listOwnInvites(spaceId)) {
    if (rec.expiresAt && rec.expiresAt < now) {
      await revokeInvite(spaceId, rec.inviteId)
      removed += 1
    }
  }
  return removed
}

// A member's authored RECEIPT that joinerKeyHex asked to join spaceId. Authored in our own
// (replicated) bee — the pending joiner's own bee is never opened (read gate), so the request
// rides a member's receipt. Idempotent: re-author only when our own dismissal currently
// supersedes the receipt (they were denied/withdrew and are knocking again), so a fresh ts
// overrides the tombstone; otherwise no-op to avoid append churn on every reconnect.
export async function markRequest(spaceId, joinerKeyHex, { displayName = 'Unknown', avatar = null, refresh = false } = {}) {
  await ensureMembershipManifestCap()
  const reqKey = 'request/' + spaceId + '/' + joinerKeyHex
  const existing = await profileBee.get(reqKey)
  // `refresh` forces a fresh ts even over a lingering receipt: a peer we observed LEAVE and is now
  // re-requesting must advance its receipt past our leave stamp, or a co-member reading this receipt
  // via replication (that never saw a direct frame) would keep suppressing the rejoin. Without it,
  // markRequest short-circuits on the stale receipt and the ts never moves.
  if (existing && !refresh) {
    const denial = await profileBee.get('denied/' + spaceId + '/' + joinerKeyHex)
    if (!denial || (denial.value?.ts || 0) < (existing.value?.ts || 0)) return
    await profileBee.del('denied/' + spaceId + '/' + joinerKeyHex)
  }
  await profileBee.put(reqKey, { displayName, avatar, ts: Date.now() })
}

// Durable, replicated dismissal of a request (a member's deny, or a joiner withdrawal we saw).
// The fold subtracts it (LWW vs the receipt ts), so the banner clears everywhere and stays
// cleared across restart. Also drops our own receipt for tidiness.
export async function markRequestDenied(spaceId, joinerKeyHex) {
  await ensureMembershipManifestCap()
  await profileBee.put('denied/' + spaceId + '/' + joinerKeyHex, { ts: Date.now() })
  await profileBee.del('request/' + spaceId + '/' + joinerKeyHex)
}

// Drop our own receipt without a tombstone — used once a request is APPROVED (the approval
// record + membership already remove the joiner from the pending fold; this is housekeeping).
export async function clearRequest(spaceId, joinerKeyHex) {
  await profileBee.del('request/' + spaceId + '/' + joinerKeyHex)
}

export async function readPeerRequests(profileKeyHex, spaceId) {
  try { return await withReadTimeout(loadPeerEntries(profileKeyHex, 'request/' + spaceId + '/'), peerReadTimeoutMs(), []) }
  catch { return [] }
}

export async function readPeerDenials(profileKeyHex, spaceId) {
  try { return await withReadTimeout(loadPeerEntries(profileKeyHex, 'denied/' + spaceId + '/'), peerReadTimeoutMs(), []) }
  catch { return [] }
}

// Stream one prefix of a peer's replicated bee (the `lt` bound mirrors the approvals stream:
// '0' (0x30) is the byte after '/' (0x2f)). Cap-gated + bounded like the other peer reads.
function loadPeerEntries(profileKeyHex, prefix) {
  return withPeerBee(profileKeyHex, async (bee) => {

    const cap = await bee.get(CAP_MEMBERSHIP_MANIFEST)
    if (!cap?.value) return []
    const limit = getResourceCaps().requestsPerMember
    const out = []
    for await (const entry of bee.createReadStream({ gte: prefix, lt: prefix.slice(0, -1) + '0' }, limit ? { limit } : undefined)) {
      const joiner = entry.key.slice(prefix.length)
      const v = entry.value || {}
      out.push({
        joiner,
        displayName: clampDisplayName(v.displayName || 'Unknown'),
        avatar: sanitizeAvatar(v.avatar || null, getResourceCaps().avatarMaxBytes),
        ts: v.ts || 0,
      })
    }
    return out
  }, { fallback: [] })
}

// One peer's full membership record for a space, the unit the OR-Set fold consumes:
// `{ active, approvals }` where active = its own `member/<S>.active` and approvals = the
// joiner keys it authored `approved/<S>/*` for. Returns null when the peer has no
// membership manifest at all (cap unset) — i.e. "unknown / not replicated yet", which the
// fold treats as absent (vs. a present record with active:false, which means "left").
// `memberSeq`/`approvalSeqs` carry the log positions the fold compares to discount a vouch
// authored after its author's own departure; both are null/empty for a peer that recorded its
// departure by deleting the key, and the fold then skips that check.
// Bounded like the other peer reads so an unreachable bee degrades to null, not a hang.
export async function readMembershipRecord(profileKeyHex, spaceId) {
  try {
    return await withReadTimeout(loadMembershipRecord(profileKeyHex, spaceId), peerReadTimeoutMs(), null)
  } catch {
    return null
  }
}

function loadMembershipRecord(profileKeyHex, spaceId) {
  return withPeerBee(profileKeyHex, async (bee) => {

    const cap = await bee.get(CAP_MEMBERSHIP_MANIFEST)
    if (!cap?.value) return null
    const memberEntry = await bee.get('member/' + spaceId)
    const active = memberEntry ? !!memberEntry.value?.active : false
    const memberTs = memberEntry ? (memberEntry.value?.ts || 0) : 0
    const memberSeq = typeof memberEntry?.seq === 'number' ? memberEntry.seq : null
    const prefix = 'approved/' + spaceId + '/'
    const limit = getResourceCaps().approvalsPerMember
    const approvals = []
    const approvalSeqs = new Map()
    for await (const entry of bee.createReadStream({ gte: prefix, lt: 'approved/' + spaceId + '0' }, limit ? { limit } : undefined)) {
      const joiner = entry.key.slice(prefix.length)
      approvals.push(joiner)
      if (typeof entry.seq === 'number') approvalSeqs.set(joiner, entry.seq)
    }
    return { active, approvals, memberTs, memberSeq, approvalSeqs }
  })
}

// Durably pull a joiner's OWN profile core into our store while the joiner is still connected —
// called from the approve path, the one window the joiner is guaranteed reachable. Without it, a
// joiner that disconnects right after a co-member's approval leaves NO peer holding its own
// record, and the OR-Set fold (which requires the joiner's own `member/<S>.active`) can never
// converge it on anyone — the owner included (the joiner is offline and the approver never
// replicated it).
//
// We download the WHOLE (tiny) core to a COMPLETE contiguous copy — not a sparse record-read.
// A sparse read fetches only the blocks on the record's B-tree path, leaving gaps; the owner
// then opens the joiner's core against US (the only holder) and its contiguous live follow can't
// reconstruct the record from a sparse remote, so it stalls (peers=1 yet no blocks ever land).
// Holding the full core lets us serve every block the owner asks for.
//
// Best-effort and bounded: never throws, never blocks approval past `timeoutMs`; on timeout we
// fall back to the pre-existing (race-prone) live follow. timeoutMs<=0 disables capture.
export async function captureJoinerMembership(joinerKeyHex, spaceId, { timeoutMs = getCaptureMemberRecordMs() } = {}) {
  if (!(timeoutMs > 0)) return false
  const startedAt = Date.now()
  const r = await capturePeerBee(joinerKeyHex, { deadline: startedAt + timeoutMs })
  if (r.complete) return true
  // len=0 ⇒ the joiner's profile-bee head never reached us in time (replication/announce);
  // len>0 && contig<len ⇒ the head arrived but blocks stalled (starved session / throughput).
  log.debug(`membership capture timed out — ${joinerKeyHex.slice(0, 8)} space ${spaceId.slice(0, 8)} len=${r.length} contig=${r.contiguous} ${Date.now() - startedAt}ms`)
  return false
}

// Bounded head refresh: race update() against `ms` so an already-up-to-date core (no upgrade
// coming) can't hang the caller on update({ wait: true }).
async function boundedUpdate(core, ms) {
  await withReadTimeout(core.update({ wait: true }).catch(() => {}), ms, undefined)
}

// One bounded read of a peer's profile bee: open, pull the head, run `fn`, close — whatever fn
// does. Closing releases only THIS session; the core stays open for every other holder (a member
// view's follow, the avatar listener), and once the last session goes corestore reclaims it on
// its idle GC, which also takes it off every replication stream. A close while update() is in
// flight cancels that request (REQUEST_CANCELLED), which the callers already map to the
// fallback. Mirrors the capture paths, which always closed. One budget covers the head sync and
// the read together, so a caller's deadline is charged once rather than once per phase.
export async function withPeerBee(profileKeyHex, fn, {
  timeoutMs = peerReadTimeoutMs(),
  fallback = null,
  sync = true,
} = {}) {
  // A read that does not sync is answerable from local blocks by construction, so its session has
  // no reason to advertise the core to every connected peer for the length of the read.
  const active = sync
  const deadline = Date.now() + timeoutMs
  let bee = null
  try {
    // Inside the try: a malformed key or a store closing during shutdown must degrade to the
    // fallback like any other unreadable peer, not reject into a caller that has no catch
    // (buildWantedKeys awaits this bare, and one throw would abort the whole leftover scan).
    bee = openProfileBee(b4a.from(profileKeyHex, 'hex'), { timeoutMs, active })
    await bee.ready()
    if (sync) await boundedUpdate(bee.core, Math.max(0, deadline - Date.now()))
    return await withReadTimeout(fn(bee), Math.max(0, deadline - Date.now()), fallback)
  } catch (err) {
    // Say it: without this the callers' own catch/log lines are unreachable, and a real bug in
    // `fn` (a bad key encoding, a decode failure) is indistinguishable from "peer offline".
    log.debug('peer bee read failed for', profileKeyHex.slice(0, 16) + '...', '-', err.message)
    return fallback
  } finally {
    if (bee) await bee.close().catch(() => {})
  }
}

// Copy a peer's profile bee to a CONTIGUOUS local prefix using EXPLICIT block gets, so
// enforcement reads stay answerable from a local snapshot after the author goes offline.
// A contiguous prefix is what makes offline snapshot reads sound: a checkout at
// contiguousLength only ever touches local blocks. Idempotent — gets on local blocks skip
// the network, so re-running is cheap. `capped` marks a bee larger than the sweep budget:
// the prefix is as complete as we will ever make it, so callers must retire the key rather
// than retry forever (records past the cap are not snapshot-readable — surfaced as a warn).
export async function capturePeerBee(profileKeyHex, {
  deadline = Date.now() + getCaptureMemberRecordMs(),
  maxBlocks = getResourceCaps().peerBeeCaptureMaxBlocks,
  parallel = 8,
} = {}) {
  const bee = openProfileBee(b4a.from(profileKeyHex, 'hex'))
  try {
    await bee.ready()
    const core = bee.core
    try {
      await boundedUpdate(core, Math.min(1000, Math.max(0, deadline - Date.now())))
      const target = Math.min(core.length, maxBlocks)
      await sweepBlocks(core, target, parallel, deadline)
      const capped = target < core.length
      if (capped) log.warn(`peer-bee exceeds the capture cap — ${profileKeyHex.slice(0, 8)} len=${core.length} cap=${maxBlocks}; records past the cap are not readable offline`)
      return { complete: core.length > 0 && core.contiguousLength >= target, capped, contiguous: core.contiguousLength, length: core.length }
    } catch (err) {
      log.debug(`peer-bee capture incomplete — ${profileKeyHex.slice(0, 8)} len=${core.length} contig=${core.contiguousLength}: ${err?.message || err}`)
      return { complete: false, capped: false, contiguous: core.contiguousLength, length: core.length }
    }
  } catch {
    return { complete: false, capped: false, contiguous: 0, length: 0 }
  } finally {
    await bee.close().catch(() => {})
  }
}

function sweepBlocks(core, target, parallel, deadline) {
  const indices = []
  for (let i = core.contiguousLength; i < target; i++) indices.push(i)
  return mapLimit(indices, parallel, (i) => {
    if (Date.now() >= deadline) return null
    const budget = Math.min(Math.max(1000, deadline - Date.now()), 2500)
    return core.get(i, { timeout: budget })
  })
}

// Length of a peer's bee as currently known locally. The session is opened on an
// already-cached core (the member view follows it), so `length` reads synchronously;
// close it anyway — corestore tracks a session per get() until it is closed.
export async function peerBeeLength(profileKeyHex) {
  let bee
  try {
    bee = openProfileBee(b4a.from(profileKeyHex, 'hex'))
    await bee.ready()
    return bee.core.length
  } catch {
    return 0
  } finally {
    if (bee) await bee.close().catch(() => {})
  }
}

// Publish OUR space drive's key into our own (replicated) profile bee, keyed by space. The live
// handshake announces the driveKey too, but a member derived purely from replicated records (no
// direct handshake, e.g. a peer approved by a co-member) never sees that announcement — without
// this record it has no driveKey and can't open our drive, so our files stay invisible to it.
// Publishing it here lets the fold hydrate driveKey from records like it does displayName/avatar.
// Safe: the drive is encrypted with the space content key (SCK), and only members (who hold the
// SCK) meaningfully replicate this bee.
export async function markSpaceDriveKey(spaceId, driveKeyHex) {
  if (!profileBee || !driveKeyHex) return
  const cur = await profileBee.get('drive/' + spaceId)
  if (cur?.value === driveKeyHex) return
  await profileBee.put('drive/' + spaceId, driveKeyHex)
}

// Publish OUR per-space loose-catalog key so peers can read our in-place loose files. Same model as
// markSpaceDriveKey: a member derived purely from replicated records gets the key from the fold.
export async function markSpaceLooseCatalogKey(spaceId, keyHex) {
  if (!profileBee || !keyHex) return
  const cur = await profileBee.get('loosecat/' + spaceId)
  if (cur?.value === keyHex) return
  await profileBee.put('loosecat/' + spaceId, keyHex)
}

// v2 (SCK-encrypted) loose-catalog key. Published in a distinct field so a reader knows
// from the FIELD that the catalog is encrypted and needs the SCK to read. Setting it clears the
// plaintext loosecat/ key so we never advertise a dangling key pointing at a purged plaintext core
// (write-time invariant: exactly one of the two is set, not a convention readers must tolerate).
export async function markSpaceLooseCatalogKeyEnc(spaceId, keyHex) {
  if (!profileBee || !keyHex) return
  if ((await profileBee.get('loosecat/' + spaceId)) != null) await profileBee.del('loosecat/' + spaceId)
  const cur = await profileBee.get('loosecatEnc/' + spaceId)
  if (cur?.value === keyHex) return
  await profileBee.put('loosecatEnc/' + spaceId, keyHex)
}

// A peer's display identity (displayName + avatar, plus per-space keys) read from their
// replicated profile bee — the same bee readMembershipRecord reads. Bounded like the other peer
// reads so an unreachable / not-yet-replicated bee degrades to null rather than hanging. Null
// when no field is present yet; the caller keeps its placeholder until a later read (driven by
// the member-view bee watcher) heals it.
export async function readProfileRecord(profileKeyHex, spaceId = null) {
  try {
    return await withReadTimeout(loadProfileRecord(profileKeyHex, spaceId), peerReadTimeoutMs(), null)
  } catch {
    return null
  }
}

function loadProfileRecord(profileKeyHex, spaceId) {
  return withPeerBee(profileKeyHex, async (bee) => {

    const displayName = await bee.get('displayName')
    const avatar = await bee.get('avatar')
    const driveKey = spaceId ? await bee.get('drive/' + spaceId) : null
    const looseCatalogKey = spaceId ? await bee.get('loosecat/' + spaceId) : null
    const looseCatalogKeyEnc = spaceId ? await bee.get('loosecatEnc/' + spaceId) : null
    if (!displayName && !avatar && !driveKey && !looseCatalogKey && !looseCatalogKeyEnc) return null
    return {
      displayName: displayName?.value ? clampDisplayName(displayName.value) : null,
      avatar: sanitizeAvatar(avatar?.value || null, getResourceCaps().avatarMaxBytes),
      driveKey: driveKey?.value || null,
      looseCatalogKey: looseCatalogKey?.value || null,
      looseCatalogKeyEnc: looseCatalogKeyEnc?.value || null,
    }
  })
}
