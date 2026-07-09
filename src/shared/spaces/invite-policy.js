// Decide what an incoming inviteId means from the resolving member's per-link record (or null).
// 'manual' on a missing record is the safe default: never auto-grant on a record we don't hold,
// never hard-refuse on its absence. `now` is injected for deterministic tests.
export function classifyInvite(rec, now = Date.now()) {
  if (!rec) return 'manual'
  if (rec.expired || (rec.expiresAt && rec.expiresAt < now)) return 'expired'
  return rec.autoApprove ? 'auto' : 'manual'
}

// Which members' locally captured snapshot may answer for a link. A member qualifies only
// when its LIVE read failed AND it has no live connection: a read that merely timed out
// against a CONNECTED peer says nothing about the record, and answering from a stale prefix
// there would auto-admit a link that peer has since revoked. A resolved live read — value or
// authoritative absence — is never second-guessed.
export function snapshotCandidates(peerKeys, liveResults, isConnected) {
  const out = []
  for (let i = 0; i < peerKeys.length; i++) {
    if (liveResults[i]?.resolved) continue
    if (isConnected(peerKeys[i])) continue
    out.push(peerKeys[i])
  }
  return out
}
