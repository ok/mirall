// Pure OR-Set (conflict-free add/remove set) fold: given the replicated membership
// records of a roster, compute the current member set. The fold is order-independent
// and idempotent — a pure function of the records, no linearization step — so every
// replica converges on the same set regardless of the order records arrive in.
//
// Rule — a peer p is a member of space S iff:
//   (1) p authored `member/S = { active: true }` (p's own bee), AND
//   (2) p is approved: p === creatorKey (the OR-Set root, who needs no approval), OR some
//       *current member* authored `approved/S/p`.
// (2) is recursive in "current member", so iterate to a fixpoint.
//
// Leaving = `del member/S` ⇒ active becomes false ⇒ p drops out. Revocation (un-approving
// someone) is NOT modelled here: approvals are grow-only — retracting one safely would
// need an ordered log to decide which of two concurrent claims came first. A peer whose
// bee hasn't replicated yet is simply absent from `records` — it (and anyone only it
// approved) stays out until it arrives, then the next fold self-heals.
//
// `records`: Map<peerKeyHex, { active: boolean, approvals: Iterable<peerKeyHex> }>.
//   `active`     — p's own `member/S.active` (false/absent ⇒ left or never joined).
//   `approvals`  — the joiner keys p authored `approved/S/<joiner>` for.
// Returns a Set<peerKeyHex> of current members.

export function foldMemberSet (records, creatorKey) {
  // Normalise once: coerce active to bool and approvals to a Set for O(1) lookup.
  const norm = new Map()
  for (const [k, rec] of records) {
    norm.set(k, { active: !!rec?.active, approvals: toSet(rec?.approvals) })
  }

  const members = new Set()
  let grew = true
  while (grew) {                       // OR-Set growth to a fixpoint
    grew = false
    for (const [k, rec] of norm) {
      if (members.has(k) || !rec.active) continue
      if (k === creatorKey || approvedByMember(k, members, norm)) {
        members.add(k)
        grew = true
      }
    }
  }
  return members
}

function approvedByMember (k, members, norm) {
  for (const m of members) {
    if (norm.get(m).approvals.has(k)) return true
  }
  return false
}

function toSet (it) {
  return it instanceof Set ? it : new Set(it || [])
}

// Whether a reconnecting member's join request may take the idempotent re-grant shortcut
// (re-sending the space content key, SCK, without a fresh approval).
// Only a peer we still hold AND have NOT observed leaving: a just-left peer (leave-tombstone set)
// can still linger in the member set while handleLeaveFrame's removeMember has not yet committed,
// so re-granting it there would silently re-admit it — it must go through fresh approval instead.
export function reconnectGrantAllowed (isMember, hasLeft) {
  return isMember && !hasLeft
}

// Whether a durable leave-tombstone still suppresses a member. Honored while the leaver has not
// re-asserted a NEWER membership than the one we saw it leave (memberTs from the leaver's own
// clock is monotonic, so a genuine rejoin writes a strictly-later member/<S> ts and self-clears
// the tombstone). leaveTs == null means "not tombstoned".
export function tombstoneActive (leaveTs, memberTs) {
  return leaveTs != null && (memberTs || 0) <= leaveTs
}

// Which fold-observed inactive peers are genuine leavers the observer must act on (revoke +
// tombstone, mirroring handleLeaveFrame): they were in OUR member set last fold AND their read
// record now says not-a-member. Both gates are positive evidence — a stranger, an unreplicated
// peer, or a cascade victim never qualifies.
export function observedLeavers (prevMembers, inactive) {
  if (!inactive || !inactive.size || !prevMembers || !prevMembers.size) return []
  const out = []
  for (const k of inactive) if (prevMembers.has(k)) out.push(k)
  return out
}
