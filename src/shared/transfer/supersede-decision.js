// Decide what to do with an active overlay transfer when its owner's catalog changed.
// 'restart' iff the catalog now points at a different, non-null contentHash; 'skip'
// for an unchanged, tombstoned (null), or mid-rehash (null) entry. Pure (unit-tested).
export function supersedeDecision (inflightHash, currentEntryHash) {
  if (!currentEntryHash) return 'skip'
  if (currentEntryHash === inflightHash) return 'skip'
  return 'restart'
}

// The owner re-published this path (a new catalog block) since our download recorded its
// source seq. Detects a remove+re-add even of identical content, and even when the receiver
// never observed the intermediate tombstone. Both seqs must be known (undefined on a legacy
// entry or an unread head) — an unknown seq is never treated as a re-publish.
export function isRepublished (currentSeq, sourceSeq) {
  return currentSeq !== undefined && sourceSeq !== undefined && currentSeq !== sourceSeq
}
