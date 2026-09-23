// Who is asking to join, held in memory and per space.
//
// Two maps on purpose. `pendingRequests` is what THIS peer heard directly — a peer that connected
// and handshook but is not yet approved. `derivedRequests` is what the member registry's fold over
// the replicated records converged on, and is authoritative for the UI. Neither survives a restart,
// because a request is a live claim: a requester that is gone should not leave a banner behind.

import { UNKNOWN_DISPLAY_NAME } from '../contract/limits.js'

// Pending join requests for v2 spaces, in-memory and per-space. A request is a peer
// that connected/handshook but isn't yet an approved member; it surfaces to the UI
// and clears on approve/deny.
const pendingRequests = new Map()

// Derived (replicated, converged) pending requests, computed by the member registry's fold over
// members' request/denied records. Authoritative for the UI; `pendingRequests` above stays as a
// live, this-peer cache that fills the gap before the first fold and carries the joiner's
// driveKey/socket for the grant path (getConvergingMember / sendMembershipGrant).
const derivedRequests = new Map()

// A deny's already-approved answer for a joiner, held until the fold has had time to carry the
// approval it learned from a co-member, so a repeated click answers without another peer read.
// Read only by the deny path; no gate consults it.
const approvedVerdicts = new Map()
const verdictKey = (spaceId, profileKey) => spaceId + '|' + profileKey

export function rememberApprovedVerdict(spaceId, profileKey, ttlMs, now = Date.now()) {
  approvedVerdicts.set(verdictKey(spaceId, profileKey), now + ttlMs)
}

export function hasApprovedVerdict(spaceId, profileKey, now = Date.now()) {
  const key = verdictKey(spaceId, profileKey)
  const until = approvedVerdicts.get(key)
  if (until === undefined) return false
  if (until > now) return true
  approvedVerdicts.delete(key)
  return false
}

export function setDerivedRequests(spaceId, map) {
  if (!map || map.size === 0) derivedRequests.delete(spaceId)
  else derivedRequests.set(spaceId, new Map(map))
}

// Returns whether the entry is new or materially changed, so a re-announced (heartbeat)
// request doesn't re-fire the approval banner on every repeat.
/**
 * @param {string} spaceId
 * @param {string} profileKey
 * @param {string} displayName
 * @param {string | null} [avatar]
 * @param {string | null} [driveKey]
 */
export function recordJoinRequest(spaceId, profileKey, displayName, avatar = null, driveKey = null) {
  if (!pendingRequests.has(spaceId)) pendingRequests.set(spaceId, new Map())
  const prev = pendingRequests.get(spaceId).get(profileKey)
  const next = {
    displayName: displayName || UNKNOWN_DISPLAY_NAME,
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
/** @param {string} spaceId @param {Set<string> | null} [memberKeys] */
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

// The requests whose `membership.requested` row is recorded or being read, each held by the claim
// of the call that took it, so a late release from a superseded call cannot free a newer knock's.
const auditClaims = new Map()
const claimKey = (spaceId, profileKey) => spaceId + '|' + profileKey

// A claim to record this request's row, or null when one is already recorded or in flight.
export function claimJoinRequestAudit(spaceId, profileKey) {
  const key = claimKey(spaceId, profileKey)
  if (auditClaims.has(key)) return null
  const claim = { key }
  auditClaims.set(key, claim)
  return claim
}

export function releaseJoinRequestAudit(claim) {
  if (auditClaims.get(claim.key) === claim) auditClaims.delete(claim.key)
}

// The request is settled, so a later re-knock is a new request and records again.
export function forgetJoinRequestAudit(spaceId, profileKey) {
  auditClaims.delete(claimKey(spaceId, profileKey))
}

// Cleared with the bee that outlived them: a request is live state, not a record.
export function resetJoinRequests() {
  pendingRequests.clear()
  derivedRequests.clear()
  auditClaims.clear()
  approvedVerdicts.clear()
}
