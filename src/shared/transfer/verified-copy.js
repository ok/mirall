// Is a local copy still the file a verified record describes? One rule, answered from the record
// and a stat alone, for the engine's fast path and for every listing row — so a row can never call
// a file verified that the engine would re-hash. Pure, so the rule is unit-tested under Node; the
// record shape is files.js's markVerified: { hash, at, local, mtime, ino }.

// Same size, same landing path when one is asked for, and the same file the record fingerprinted:
// same integer-ms mtime, and the same inode when both sides report one. A filesystem without a
// stable inode reports 0, and reading that as a mismatch would re-hash every file on every tick.
//
// A record written before the fingerprint existed carries none and keeps the weaker rule: the file
// is no newer than the record.
export function fingerprintMatches(rec, stat, expectedSize, { expectLocal = null } = {}) {
  if (!rec || !stat) return false
  if (typeof expectedSize === 'number' && stat.size !== expectedSize) return false
  if (expectLocal !== null && rec.local !== expectLocal) return false
  if (typeof rec.mtime !== 'number') return Math.floor(stat.mtimeMs) <= rec.at
  if (Math.floor(stat.mtimeMs) !== rec.mtime) return false
  if (rec.ino && stat.ino && Number(stat.ino) !== rec.ino) return false
  return true
}

export const COPY_VERDICT = Object.freeze({
  VERIFIED: 'verified',
  MODIFIED: 'modified',
  DRIFTED: 'drifted',
  UNPROVEN: 'unproven',
})

// A write to the file's content moves its mtime; an inode alone also moves on a copy, a restore or
// a remount that leaves the bytes as they were.
function contentWritten(rec, stat) {
  const mtime = Math.floor(stat.mtimeMs)
  return typeof rec.mtime === 'number' ? mtime !== rec.mtime : mtime > rec.at
}

// A listing row's reading of one local copy, judged only when the record describes this file at the
// current content (a record that names no landing path predates `local` and is taken as this
// file's, as the engine's fast path takes it). Otherwise UNPROVEN: the row keeps what the disk
// alone says.
//
// A fingerprint that moved is evidence of an edit only as far as it can be wrong at no cost. A
// changed size always is. A changed mtime is when `rehashed` — a mirror, whose next pass re-hashes
// the file and restores the row if the bytes turn out unchanged; a download is never re-hashed, so
// there it is DRIFTED: on the device, vouched for by nothing. So is an inode that moved alone.
export function verifiedCopyVerdict(rec, stat, { contentHash, expectedSize, expectLocal, rehashed = false }) {
  if (!rec || !stat || !contentHash || rec.hash !== contentHash) return COPY_VERDICT.UNPROVEN
  if (rec.local != null && rec.local !== expectLocal) return COPY_VERDICT.UNPROVEN
  if (fingerprintMatches(rec, stat, expectedSize)) return COPY_VERDICT.VERIFIED
  if (stat.size !== expectedSize) return COPY_VERDICT.MODIFIED
  if (rehashed && contentWritten(rec, stat)) return COPY_VERDICT.MODIFIED
  return COPY_VERDICT.DRIFTED
}
