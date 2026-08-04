// Pure OR-Set (conflict-free add/remove set) fold: given the replicated membership
// records of a roster, compute the current member set. The fold is order-independent
// and idempotent — a pure function of the records, no linearization step — so every
// replica converges on the same set regardless of the order records arrive in.
//
// Two INDEPENDENT questions, never conflated:
//   AUTHORIZATION — is p in the approval tree rooted at the creator? Historical and grow-only;
//     the only retraction is deleting the vouch (revokeApproval), an edit to the author's own log.
//   LIVENESS — does p assert `member/S = { active: true }`? Only p writes it, only p retracts it.
// p is a member iff both hold.
//
// Deriving authorization from the MEMBER set rather than from the tree alone would let a departure
// retroactively invalidate every vouch its author ever wrote — the creator leaving would unroot the
// tree and empty the space, and any inviter leaving would orphan everyone it alone vouched for. So
// the creator's key is the permanent root of authorization: it marks where the chain starts and
// confers no powers, while the creator stays subject to liveness like every other member.
//
// A vouch authored AFTER its author recorded its own departure confers nothing. `approvalSeqs` and
// `memberSeq` are positions in the same append-only log, so that comparison needs no clock and no
// local state, and every replica derives the same answer. Absent seqs skip the check.
//
// Third-party removal is NOT modelled: a claim about someone else's membership would need an ordered
// log to decide which of two concurrent claims came first. A peer whose bee hasn't replicated yet is
// simply absent from `records` — it (and anyone only it approved) stays out until it arrives, then
// the next fold self-heals.
//
// `records`: Map<peerKeyHex, { active, approvals, memberSeq?, approvalSeqs? }>.
//   `active`       — p's own `member/S.active` (false ⇒ departed, absent ⇒ never joined).
//   `approvals`    — the joiner keys p authored `approved/S/<joiner>` for.
//   `memberSeq`    — log position of p's own `member/S` record, when known.
//   `approvalSeqs` — Map<joinerKey, seq> for those approvals, when known.

// Members plus the authorization tree behind them. Callers that only need the roster take
// `.members`; discovery takes `.authorized`, since it must open the bees of a departed member's
// approvees too or they are never fetched and can never heal.
export function foldMembership (records, creatorKey) {
  const norm = new Map()
  for (const [k, rec] of records) {
    norm.set(k, {
      active: !!rec?.active,
      approvals: toSet(rec?.approvals),
      memberSeq: typeof rec?.memberSeq === 'number' ? rec.memberSeq : null,
      approvalSeqs: rec?.approvalSeqs instanceof Map ? rec.approvalSeqs : null,
    })
  }

  // Reachability from the root through standing approval edges, ignoring `active`. Seeded with
  // creatorKey unconditionally so the root anchors the tree even when its own record has not
  // replicated — it then contributes no edges, leaving the tree at {creator}.
  const authorized = new Set()
  const approved = new Set()
  const pending = []
  if (creatorKey) { authorized.add(creatorKey); pending.push(creatorKey) }
  while (pending.length) {
    const rec = norm.get(pending.pop())
    if (!rec) continue
    for (const j of rec.approvals) {
      if (!vouchStands(rec, j)) continue
      approved.add(j)
      if (authorized.has(j)) continue
      authorized.add(j)
      pending.push(j)
    }
  }

  const members = new Set()
  for (const k of authorized) if (norm.get(k)?.active) members.add(k)

  return { members, authorized, approved }
}

// A departed peer's vouch stands only if the log shows it was authored before the departure.
function vouchStands (rec, joiner) {
  if (rec.active || rec.memberSeq === null || !rec.approvalSeqs) return true
  const seq = rec.approvalSeqs.get(joiner)
  return seq === undefined || seq < rec.memberSeq
}

export function foldMemberSet (records, creatorKey) {
  return foldMembership(records, creatorKey).members
}

// Which of a departing peer's vouchees the observer takes over before revoking its own vouch for
// that peer. Revoking alone unroots the leaver, and with it everyone the leaver alone vouched for,
// so the observer re-parents that subtree onto itself — it had already authorized them
// transitively, so no new trust is conferred. Never the leaver itself (that would re-vouch the
// very peer being revoked) and never us (the fold roots authorization elsewhere).
export function voucheesToAdopt (approvals, selfKey, leaverKey) {
  const out = []
  for (const k of approvals || []) {
    if (k === selfKey || k === leaverKey) continue
    out.push(k)
  }
  return out
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
