// When a restored core may be written again. A core restored from a key or a backup is at most as
// long as the copies peers hold, and appending before catching up signs a second history at a length
// they already have, which every peer that sees both refuses for good. So it stays read-only until
// every connected holder has been matched and the copy is complete, and for a dwell after the first
// holder answered, so a stale holder that happens to connect first does not decide alone. A profile
// this device already holds data of, with no co-member in any space it knows, has no other holder.
import { RESTORE_VERDICT } from '../contract/restore-verdict.js'

export function releaseVerdict({ localLength, contiguousLength, holderLengths, firstHolderAt, now, dwellMs, coMembers }) {
  if (localLength > 0 && coMembers === 0) return RESTORE_VERDICT.CAUGHT_UP
  if (holderLengths.length === 0 || firstHolderAt === null) return RESTORE_VERDICT.NO_HOLDER
  if (localLength < Math.max(...holderLengths)) return RESTORE_VERDICT.BEHIND
  if (contiguousLength < localLength) return RESTORE_VERDICT.DOWNLOADING
  if (now - firstHolderAt < dwellMs) return RESTORE_VERDICT.DWELL
  return RESTORE_VERDICT.CAUGHT_UP
}
