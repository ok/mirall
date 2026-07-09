import { getSpace, listSpaces, mutateMembers, setDerivedRequests, clearJoinRequest, loadLeftTombstones, clearLeftTombstone, persistLeftTombstone } from './space.js'
import { getLocalPublicKeyHex, revokeApproval, readMembershipRecord, capturePeerBee, peerBeeLength } from './profile.js'
import { createMemberView } from './member-view.js'
import { makeCaptureScheduler } from './bee-capture.js'
import { mergeMemberIdentity } from './member-identity.js'
import { foldPendingSet } from './pending-set.js'
import { tombstoneActive, observedLeavers } from './member-set.js'
import { createLogger } from '../core/logger.js'

const log = createLogger('member-registry')

// One live member-view per active v2 space. The view folds the replicated membership
// records into the current member set and, on every change (local or replicated),
// reconciles it into `space.members` (the renderer's read model) — making membership a
// derived fact, not a handshake-time cache. Swarm metadata (a connected peer's driveKey /
// displayName / avatar) and the IPC emitter are injected so this module stays free of a
// swarm import (no cycle); swarm owns connectedPeers, this owns the derived set.
const views = new Map()   // spaceId -> { view, members: Set<keyHex> }

// Explicit-get capture of every followed roster bee, so enforcement reads (invite
// records, member records) stay answerable from a local contiguous snapshot after the
// author goes offline — independent of the follow's range download, which a starved
// replication session never delivers. Fire-and-forget everywhere; the convergence tick
// retries deficits under its own throttle.
const captures = makeCaptureScheduler({
  capture: (key) => capturePeerBee(key),
  coreLength: peerBeeLength,
  onError: (key, err) => log.debug('peer-bee capture failed:', key.slice(0, 12), err?.message || err),
})

// One bee is followed by every view whose roster reaches it, so a key is only retired
// once the last space referencing it closes — otherwise leaving one space would stop
// capturing a peer we still share another space with.
const captureRefs = new Map()   // keyHex -> Set<spaceId>

function trackCapture (spaceId, key) {
  let spaces = captureRefs.get(key)
  if (!spaces) { spaces = new Set(); captureRefs.set(key, spaces) }
  spaces.add(spaceId)
  captures.schedule(key)
}

function releaseCaptures (spaceId) {
  for (const [key, spaces] of captureRefs) {
    if (!spaces.delete(spaceId)) continue
    if (spaces.size === 0) {
      captureRefs.delete(key)
      captures.forget(key)
    }
  }
}

export function scheduleCapture (key) {
  captures.schedule(key)
}

export function captureDeficits () {
  return captures.incomplete()
}

// Peers we received a leave FRAME from. A leaver's `del member/S` is durable but may not
// replicate before they disconnect during teardown, so the fold would keep reading their
// stale `active:true` record and re-add them. This tombstone makes the (reliable) leave
// frame authoritative for the derived set: the fold subtracts these keys (so a confirmed
// leaver is never re-added), and the handshake gate ignores their lingering frames — until
// they genuinely rejoin (dropTombstone, driven by a fresh membership:request or a newer record).
// Durably backed by
// spaces-meta (loadLeftTombstones) so an applied leave survives a restart; the stored leave-ts
// lets a rejoin self-clear the tombstone via tombstoneActive.
const lefts = new Map()   // spaceId -> Map<keyHex, leaveTs>

let deps = {
  metaFor: () => null,              // (spaceId, key) => { driveKey, displayName, avatar } | null (live swarm)
  isConnected: () => false,         // (spaceId, key) => bool (a live handshake for this space)
  profileFor: async () => null,     // (spaceId, key) => { displayName, avatar } | null (replicated bee)
  readmitConnected: () => {},       // (spaceId, keys[]) => void (admit derived peers we have a socket with)
  emitMembersUpdated: () => {},     // (spaceId) => void
  emitJoinRequest: () => {},        // (spaceId, { publicKey, displayName, avatar }) => void
  emitJoinRequestsUpdated: () => {},// (spaceId) => void
  emitSharesUpdated: () => {},      // (spaceId) => void — a followed member's share/<space>/* changed
}

export function configureMemberRegistry (next) {
  deps = { ...deps, ...next }
}

// Open a view for a space once it is an approved v2 space WITH a creatorKey (the OR-Set
// root). Pending spaces and spaces without a creatorKey have no fold root to seed from,
// so they stay on the handshake-driven membership path instead.
export async function openMemberView (spaceId) {
  if (views.has(spaceId)) return
  // Claim the slot SYNCHRONOUSLY before any await so two concurrent opens can't both build a view
  // (the second would orphan the first's live bee-follow downloads). On any failure below we delete
  // the slot again, so a read throw never strands a poisoned `{view:null}` entry.
  const entry = { view: null, members: new Set(), pending: new Map(), prior: new Map(), unread: new Set() }
  views.set(spaceId, entry)
  try {
    const space = await getSpace(spaceId)
    if (!space || space.schemaVersion !== 2 || !space.creatorKey || space.status === 'pending' || space.leaving) {
      views.delete(spaceId)
      return
    }

    // Seed the tombstone set from durable storage so an applied leave keeps suppressing the leaver
    // across a restart (the in-memory Map alone would be gone). Merge, never clobber, in case a leave
    // frame already landed this session.
    const persisted = await loadLeftTombstones(spaceId)
    if (persisted.size) {
      const set = lefts.get(spaceId) || new Map()
      for (const [k, ts] of persisted) if (!set.has(k)) set.set(k, ts)
      lefts.set(spaceId, set)
    }

    // Seed prior-membership belief (key → last-known member ts) from the durable roster
    // (space.members — the last folded set reconcile persists) AND from our own authored
    // approvals. The roster alone misses a vouchee reconcile dropped on a transient null read;
    // the approvals seed covers exactly the keys where a missed revoke matters, and it keeps a
    // leaver seeded until the revoke actually lands (the vouch is only gone once it does).
    // `prior` is separate from `members` (the pure fold result): a fold that runs before the
    // leaver's bee replicates must not erase the belief.
    for (const m of space.members || []) entry.prior.set(m.publicKey, 0)
    const own = await readMembershipRecord(getLocalPublicKeyHex(), spaceId)
    for (const j of own?.approvals || []) if (!entry.prior.has(j)) entry.prior.set(j, 0)

    entry.view = createMemberView({
      spaceId,
      creatorKey: space.creatorKey,
      selfKey: getLocalPublicKeyHex(),
      onMembers: ({ members, considered, approved, requests, denied, memberTs, inactive, unread }) => {
        entry.unread = unread || new Set()
        // Subtract leavers (see `lefts`): without this the fold re-adds a member whose del-record
        // hasn't replicated yet from their stale active copy. A tombstone self-clears once the leaver
        // re-asserts a newer member/<S> (tombstoneActive), covering the creator/root too.
        const left = lefts.get(spaceId)
        let eff = members
        if (left && left.size) {
          eff = new Set()
          for (const k of members) {
            const leaveTs = left.get(k)
            if (tombstoneActive(leaveTs, memberTs?.get(k) || 0)) continue
            if (leaveTs != null) dropTombstone(spaceId, k)
            eff.add(k)
          }
        }
        // The observed-leave decision reads `prior` (was a member, now reads active:false) before
        // the merge below; a leaver is never in `eff`, so its last-seen ts is retained. `prior` is
        // monotonic (bounded like the tombstones: distinct keys ever held) — an acted-on leaver
        // staying in it is harmless behind the isLeft guard.
        applyObservedLeaves(spaceId, entry, inactive)
        entry.members = eff
        for (const k of eff) entry.prior.set(k, memberTs?.get(k) ?? entry.prior.get(k) ?? 0)
        reconcile(spaceId, eff, considered).catch((err) => log.warn('reconcile failed:', spaceId, err.message))
        reconcilePending(spaceId, entry, { requests, denied, members: eff, approved, lefts: left })
      },
      onError: (err) => log.warn('member view error:', spaceId, err.message),
      onBeeAppend: () => deps.emitSharesUpdated(spaceId),
      onFollow: (key) => trackCapture(spaceId, key),
    })
  } catch (err) {
    views.delete(spaceId)
    throw err
  }
  log.info('opened member view for space', spaceId)
}

export function closeMemberView (spaceId) {
  const entry = views.get(spaceId)
  if (!entry) return
  views.delete(spaceId)
  lefts.delete(spaceId)
  releaseCaptures(spaceId)
  setDerivedRequests(spaceId, null)
  Promise.resolve(entry.view?.close?.()).catch(() => {})
}

// Record that `key` left this space (from their leave frame) at the leaver's clock stamp `leaveTs`.
// Subtracted from the fold and honored by the handshake gate so a confirmed leaver doesn't resurrect
// from a stale record.
export function markLeft (spaceId, key, leaveTs) {
  let set = lefts.get(spaceId)
  if (!set) lefts.set(spaceId, set = new Map())
  set.set(key, leaveTs)
}

// Clear both the in-memory and the durable tombstone — a genuine rejoin (fresh membership:request,
// or a newer member/<S> ts observed by the fold). Returns the durable-clear promise (which never
// rejects — clearLeftTombstone swallows) so a caller can await it; the fold ignores it.
export function dropTombstone (spaceId, key) {
  lefts.get(spaceId)?.delete(key)
  return clearLeftTombstone(spaceId, key)
}

export function isLeft (spaceId, key) {
  return lefts.get(spaceId)?.has(key) || false
}

// Spaces whose last fold considered roster keys it could not read (records not replicated
// yet) — the level signal the convergence tick keys on. A healthy space returns nothing.
export function rosterDeficits () {
  const out = new Map()
  for (const [spaceId, entry] of views) {
    if (entry.unread?.size) out.set(spaceId, entry.unread)
  }
  return out
}

export function recomputeMemberView (spaceId) {
  views.get(spaceId)?.view?.recompute()
}

// Level-triggered twin of handleLeaveFrame: a peer we previously counted as a member whose bee
// now reads active:false (their durable `del member/<S>` replicated to us) is a genuine
// self-leave, even though the live leave frame never reached us (we were offline). Mirror the
// frame handler for it — revoke our grow-only vouch (so a later re-assert can't be silently
// re-admitted off it) and tombstone the leaver. leaveTs is the leaver's last-observed member ts
// (single-clock, so a genuine rejoin self-clears via tombstoneActive); 0 (inert) when unknown —
// the revoke, the load-bearing effect, is ts-independent. Skips frame-handled leavers (isLeft),
// so the two paths never double-act.
function applyObservedLeaves (spaceId, entry, inactive) {
  for (const key of observedLeavers(entry.prior, inactive)) {
    if (isLeft(spaceId, key)) continue
    applyObservedLeave(spaceId, key, entry.prior.get(key) || 0)
  }
}

// The revoke comes FIRST and gates the tombstone: markLeft would satisfy the isLeft skip above
// (and the durable tombstone re-seeds it every boot), so tombstoning before a failed revoke
// would silence every retry while the vouch survives — the exact re-admit hole this closes. A
// failed revoke leaves the key unhandled instead: the vouch keeps it seeded in `prior` at the
// next view open, so the next session's first fold retries. Both writes are idempotent, so an
// overlapping fold double-applying is harmless.
async function applyObservedLeave (spaceId, key, leaveTs) {
  try {
    await revokeApproval(spaceId, key)
  } catch (err) {
    log.warn('observed-leave revoke failed (will retry on a later fold):', spaceId, key.slice(0, 12), err.message)
    return
  }
  markLeft(spaceId, key, leaveTs)
  persistLeftTombstone(spaceId, key, leaveTs).catch((err) => log.warn('observed-leave tombstone failed:', spaceId, key.slice(0, 12), err.message))
  log.info('observed leave via replication — revoked + tombstoned:', key.slice(0, 12) + '...', '→', spaceId)
}

export async function openMemberViewsForKnownSpaces () {
  for (const space of await listSpaces()) {
    try { await openMemberView(space.spaceId) } catch (err) { log.warn('open view failed:', space.spaceId, err.message) }
  }
}

export function closeAllMemberViews () {
  for (const spaceId of [...views.keys()]) closeMemberView(spaceId)
  captureRefs.clear()
  captures.clear()
}

// True iff `key` is in the current derived member set for the space (the last fold result).
export function isMember (spaceId, key) {
  return views.get(spaceId)?.members.has(key) || false
}

// True iff the fold currently holds an approved/<S>/<key> receipt from some member. The
// receipt is durable and replicated even while the joiner's own member/<S> has not
// converged — exactly the state of a joiner approved while OFFLINE (its grant frame was
// undeliverable): approved on record, not yet a member, still knocking.
export function isApprovedJoiner (spaceId, key) {
  return views.get(spaceId)?.approved?.has(key) || false
}

// True iff the fold holds a denial for `key` that no fresher request supersedes — the
// LWW rule already resurfaces a genuinely newer knock as pending, which this excludes,
// so a re-sent deny can never swallow a real re-request.
export function isDeniedJoiner (spaceId, key) {
  const entry = views.get(spaceId)
  return !!entry?.denied?.has(key) && !entry.pending?.has(key)
}

// Reconcile the derived set into space.members. Membership (add/remove) is decided exactly as
// before: ADD members in the set we don't hold yet; REMOVE a held member only with positive
// evidence of leaving (their bee was considered AND says not-a-member AND no live handshake
// contradicts it) — mere absence never removes anyone → no flicker. What changes here is that each
// member's IDENTITY (displayName/avatar/driveKey) is hydrated from the replicated profile bee as
// well as from live swarm meta, so a member we have no live handshake with still shows their real
// name + photo instead of "Unknown"/initials.
async function reconcile (spaceId, members, considered) {
  // space.members is the OTHER members (the renderer shows self separately; every consumer
  // — warmKnownPeerDrives, cleanupSpaceDrives, isApprovedByPeers — skips self). The fold's
  // set includes self, so exclude self throughout.
  const self = getLocalPublicKeyHex()

  // Read identity from each member's replicated bee (the same bees the fold just walked). Bounded +
  // parallel; a not-yet-replicated bee resolves to null and we keep our placeholder until its
  // append re-folds us.
  const want = [...members].filter((k) => k !== self)
  const profiles = new Map()
  await Promise.all(want.map(async (key) => {
    const p = await deps.profileFor(spaceId, key)
    if (p) profiles.set(key, p)
  }))

  const changed = await mutateMembers(spaceId, (current) => {
    const next = []
    let dirty = false

    for (const m of current) {
      if (!members.has(m.publicKey)) {
        const determined = considered.has(m.publicKey)
        if (!determined || deps.isConnected(spaceId, m.publicKey)) { next.push(m); continue } // keep
        dirty = true; continue                                                                // left → drop
      }
      const { entry, changed: chg } = mergeMemberIdentity({
        publicKey: m.publicKey,
        meta: deps.metaFor(spaceId, m.publicKey),
        profile: profiles.get(m.publicKey),
        held: m,
      })
      next.push(chg ? entry : m)
      if (chg) dirty = true
    }

    const present = new Set(next.map((m) => m.publicKey))
    for (const key of members) {
      if (key === self || present.has(key)) continue
      const { entry } = mergeMemberIdentity({
        publicKey: key,
        meta: deps.metaFor(spaceId, key),
        profile: profiles.get(key),
        held: null,
      })
      next.push(entry)
      dirty = true
    }

    return dirty ? next : null
  })

  if (changed) deps.emitMembersUpdated(spaceId)

  // Any member the fold vouches for that we have a live socket with but no admitted handshake for
  // this space → ask the swarm to (re)admit so presence + meta establish. Runs AFTER the write
  // above, so the swarm's gate sees them as known and admits (including the creator, approved by
  // nobody). Self-limiting: once admitted, isConnected is true so they stop being passed here.
  const unconnected = want.filter((k) => !deps.isConnected(spaceId, k))
  if (unconnected.length) deps.readmitConnected(spaceId, unconnected)
}

const EMPTY = new Set()

// Reconcile the derived PENDING-request set into the read model — the mirror of reconcile() for
// the member set. Pending is now a derived, replicated fact (foldPendingSet over members'
// receipts + dismissals), so a co-member sees the same "X wants to join" as the member that
// heard X, it survives restart, and it doesn't need X online. Writes the converged set into
// space.js (listJoinRequests / pendingCount read it) and emits the existing renderer events: a
// per-joiner member-join-request for each NEWLY-appeared request (drives the sticky toast — the
// renderer dedups by (spaceId, publicKey)), and one join-requests-updated whenever the set
// changed (refreshes banner + list pill + modal). Idempotent: no churn when nothing changed.
function reconcilePending (spaceId, entry, { requests, denied, members, approved, lefts }) {
  const pending = foldPendingSet({ requests, denied, members, approved, lefts })

  // Retain the fold's approval receipts and denial tombstones on the live entry: the
  // join-request gate consults them (isApprovedJoiner / isDeniedJoiner) to converge a
  // joiner whose approve/deny happened while it was offline.
  entry.approved = approved || EMPTY
  entry.denied = denied || null

  // A tombstoned peer that surfaced as pending sent a fresh re-request (its receipt is newer than
  // our leave stamp) — lift the tombstone so the member-set fold and the handshake gate stop
  // suppressing it, and it goes through the normal fresh-approval flow.
  if (lefts && lefts.size) for (const k of pending.keys()) if (lefts.has(k)) dropTombstone(spaceId, k)

  // The records show these joiners resolved (joined / approved / left / dismissed); drop any stale live
  // cache entry so listJoinRequests (which merges live) can't resurface them. No-op if already absent.
  const resolved = new Set([...(members || EMPTY), ...(approved || EMPTY), ...(lefts ? lefts.keys() : []), ...(denied ? denied.keys() : [])])
  for (const k of resolved) clearJoinRequest(spaceId, k)

  const prev = entry.pending || new Map()
  entry.pending = pending
  setDerivedRequests(spaceId, pending)

  let changed = pending.size !== prev.size
  for (const [k, meta] of pending) {
    if (prev.has(k)) continue
    changed = true
    deps.emitJoinRequest(spaceId, { publicKey: k, displayName: meta.displayName, avatar: meta.avatar })
  }
  if (!changed) { for (const k of prev.keys()) if (!pending.has(k)) { changed = true; break } }
  if (changed) deps.emitJoinRequestsUpdated(spaceId)
}
