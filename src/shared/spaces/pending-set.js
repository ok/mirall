// Pure fold (mirrors member-set.js): from the request RECEIPTS and dismissal TOMBSTONES
// authored by the current members of a space, compute who is waiting for approval. A pending
// joiner's own bee is never replicated to members (read gate), so a request rides a member's
// `request/<S>/<j>` receipt; a member's `denied/<S>/<j>` tombstone withdraws it.
//
// Joiner j is pending iff some member vouched a receipt for j, j is not already a member /
// approved-by-any-member / a known leaver, and j's freshest receipt is newer than j's freshest
// dismissal (LWW, last-writer-wins — a deny clears the ask, a later fresh knock re-surfaces
// it; revocation is not modelled, the same stance as member-set.js).
//
//   requests : Map<joinerKey, { displayName, avatar, ts }>   (union across members, max ts)
//   denied   : Map<joinerKey, ts>                            (union across members, max ts)
//   members, approved, lefts : Set<keyHex>
// Returns Map<joinerKey, { displayName, avatar, ts }> of current pending requests.

const EMPTY_SET = new Set()
const EMPTY_MAP = new Map()

export function foldPendingSet ({ requests, denied, members, approved, lefts }) {
  const isMember = members || EMPTY_SET
  const isApproved = approved || EMPTY_SET
  const leftAt = lefts || EMPTY_MAP          // Map<joinerKey, leaveTs>
  const tombstones = denied || EMPTY_MAP

  const out = new Map()
  for (const [j, meta] of (requests || EMPTY_MAP)) {
    if (isMember.has(j) || isApproved.has(j)) continue
    // A leaver stays suppressed only while their leave is at least as recent as this receipt; a
    // strictly-newer receipt is a genuine re-request and must surface (mirrors the denial rule
    // below). Without this a durable tombstone would hide a rejoin request forever on any co-member
    // that learned of the request via replication rather than a direct frame.
    const leaveTs = leftAt.get?.(j)
    if (leaveTs != null && meta.ts <= leaveTs) continue
    const deniedTs = tombstones.get(j)
    if (deniedTs != null && deniedTs >= meta.ts) continue
    out.set(j, { displayName: meta.displayName || 'Unknown', avatar: meta.avatar ?? null, ts: meta.ts })
  }
  return out
}
