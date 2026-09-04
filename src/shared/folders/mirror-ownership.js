// Whose bytes are on disk? The one question the mirror never asked.
//
// The materialize path has always compared the local file against the owner's CURRENT content
// hash. That answers "is this file up to date?" and nothing else — when it says no, the reason is
// either that the owner moved on or that the user edited our copy, and those two need opposite
// handling. Treating every mismatch as the first is what let a tick rename fetched bytes over a
// user's edit.
//
// The evidence to separate them is the ANCESTOR: the hash the mirror itself last delivered for that
// path, recorded by markVerified() on every landing and durable for the life of the mount. Disk ===
// ancestor means our copy is untouched, so a difference from the owner is the owner's doing. Disk
// !== ancestor means someone else wrote those bytes.
//
// Pure on purpose (same shape as supersede-decision.js / mount-fault.js): every branch here decides
// whether a user's file may be destroyed, and that decision should be testable without a disk.

export const LOCAL_COPY = {
  // The local file already IS the owner's current content — nothing to fetch.
  OWNER_CURRENT: 'owner-current',
  // Exactly the bytes we last delivered, so the difference from the owner is the OWNER's edit.
  OURS: 'ours',
  // Neither the owner's current content nor what we delivered: the USER edited our copy.
  DIVERGED: 'diverged',
  // No ancestor on record, or the local file could not be read. Not proof of anything.
  UNKNOWN: 'unknown',
}

export function classifyLocalCopy ({ diskHash = null, ownerHash = null, ancestorHash = null } = {}) {
  // An unreadable local file is not an invitation to replace it.
  if (!diskHash) return LOCAL_COPY.UNKNOWN
  // Checked before the ancestor: when all three agree the file is current, and that is the more
  // useful answer than "ours".
  if (ownerHash && diskHash === ownerHash) return LOCAL_COPY.OWNER_CURRENT
  if (!ancestorHash) return LOCAL_COPY.UNKNOWN
  return diskHash === ancestorHash ? LOCAL_COPY.OURS : LOCAL_COPY.DIVERGED
}

// Only a copy we can PROVE is ours may be written over in place.
//
// UNKNOWN deliberately fails closed. A missing ancestor is an absence of evidence, not evidence of
// ownership, and the two mistakes are not symmetric: a needless sibling is a file the user can
// delete in a second, while a wrong overwrite is unrecoverable — there is no trash on this path and
// no audit row to reconstruct from.
export function mayOverwriteInPlace (verdict) {
  return verdict === LOCAL_COPY.OURS || verdict === LOCAL_COPY.OWNER_CURRENT
}
