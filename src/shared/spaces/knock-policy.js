// How a join request ("knock") is answered. A knock arrives from a peer that is still pending on
// its own side, so it may be a first request, a reconnect, or a replay of one we already settled.
//
// Split in two because resolving the invite is NOT a pure read — an expired invite is revoked as a
// side effect — so a knock the records already settle must be answered without ever looking one
// up. Reading the invite first would revoke a link behind a peer we were about to re-grant.

import { reconnectGrantAllowed } from './membership/fold.js'

// Verdicts the records settle on their own, before any invite is read.
// `null` means the invite has to be resolved to decide.
export function knockSettledByRecords({ selfPending, isMember, hadLeft, isApproved }) {
  // We hold no content key ourselves, so we can neither grant nor meaningfully approve.
  if (selfPending) return 'ignore'
  // Still a member with no leave observed: re-grant idempotently. A peer we saw leave falls
  // through to fresh approval instead.
  if (reconnectGrantAllowed(isMember, hadLeft)) return 'regrant'
  // Approved but never confirmed — the joiner's grant frame was undeliverable, so it re-knocks on
  // every reconnect. Re-issue before the invite is consulted: the original link may be spent by
  // now and must not re-deny someone already approved.
  if (isApproved && !hadLeft) return 'regrant'
  return null
}

// The verdict once the invite (if any) has been resolved. `inviteVerdict` is classifyInvite's
// answer, or null when the knock carried no invite id.
export function knockInviteVerdict({ inviteVerdict, hasInviteRecord, hadLeft, isDenied }) {
  // The replicated record is authoritative, so a stripped or forged expiry hint cannot bypass it.
  if (inviteVerdict === 'expired') return 'deny-expired'
  if (inviteVerdict === 'auto') return 'auto-approve'
  // Denied while offline: the tombstone converged among members but the joiner never got the live
  // frame, so it is stuck pending and re-knocks. Re-send the deny so it can discard the space —
  // unless a still-valid reviewable invite backs this knock, which means the door was re-opened.
  if (isDenied && !hadLeft && !hasInviteRecord) return 'deny-replay'
  return 'review'
}
