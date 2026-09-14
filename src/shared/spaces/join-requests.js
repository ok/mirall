// Who is asking to join, held in memory and per space.
//
// Two maps on purpose. `pendingRequests` is what THIS peer heard directly — a peer that connected
// and handshook but is not yet approved. `derivedRequests` is what the member registry's fold over
// the replicated records converged on, and is authoritative for the UI. Neither survives a restart,
// because a request is a live claim: a requester that is gone should not leave a banner behind.

// Pending join requests for v2 spaces, in-memory and per-space. A request is a peer
// that connected/handshook but isn't yet an approved member; it surfaces to the UI
// and clears on approve/deny.
const pendingRequests = new Map()

// Derived (replicated, converged) pending requests, computed by the member registry's fold over
// members' request/denied records. Authoritative for the UI; `pendingRequests` above stays as a
// live, this-peer cache that fills the gap before the first fold and carries the joiner's
// driveKey/socket for the grant path (getConvergingMember / sendMembershipGrant).
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
// "pending" (a stale live/derived entry can outlive the handshake gate, which clears only the live
// cache, or an approval learned from records before the gate ran).
export function listPendingRequests(spaceId, memberKeys = null) {
  const reqs = listJoinRequests(spaceId)
  if (!memberKeys || !memberKeys.size) return reqs
  return reqs.filter((r) => !memberKeys.has(r.publicKey))
}

// The live-cache entry for a peer whose handshake was bounced into a join request, with both
// fields that handshake carried. listJoinRequests deliberately hides a driveKey-bearing entry (it
// is a converging member, not an approvable request), so the deferred-admission replay has to read
// the cache directly — off the list — to learn who it is replaying.
export function getConvergingMember(spaceId, profileKey) {
  const req = pendingRequests.get(spaceId)?.get(profileKey)
  return req?.driveKey ? { driveKey: req.driveKey, displayName: req.displayName } : null
}

export function clearJoinRequest(spaceId, profileKey) {
  return pendingRequests.get(spaceId)?.delete(profileKey) || false
}

// Cleared with the bee that outlived them: a request is live state, not a record.
export function resetJoinRequests() {
  pendingRequests.clear()
  derivedRequests.clear()
}
