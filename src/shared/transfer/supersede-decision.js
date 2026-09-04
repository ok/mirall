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

// The owner's catalog changed under an in-flight download. Four outcomes, because a re-publish
// is TWO appends — advertise(contentHash:null) → hash the source → setMaterializedHash — and the
// half-advertised window between them is neither a tombstone nor a republished-identical entry:
//
//   'drop'     — tombstoned, or re-added with identical content (do not resume the old partial)
//   'pending'  — mid-rehash: a new version is advertised but its hash is not materialized yet.
//                HOLD the transfer; setMaterializedHash is a second append that re-fires the watch.
//   'restart'  — a different, materialized contentHash → supersede from byte 0
//   'continue' — no re-publish; fall through to the plain hash-change check (an unread head or a
//                legacy entry carries no seq, so it can never be classified as a re-publish)
export function republishDecision (inflightHash, state, sourceSeq) {
  if (!state) return 'continue'
  if (state.removed) return 'drop'
  if (!isRepublished(state.seq, sourceSeq)) return 'continue'
  if (state.contentHash == null) return 'pending'
  // Identical content re-added — and, when we never recorded which hash we were fetching (a row
  // written before that field existed), anything re-published: without it we cannot prove the
  // content CHANGED, so keep the remove+re-add rule and terminate rather than silently resume.
  if (inflightHash == null || state.contentHash === inflightHash) return 'drop'
  return 'restart'
}

// The whole ladder an active slot is put through when its owner's catalog appends: the
// re-publish classification first, then the plain hash-change check for everything it left
// as 'continue'. Both consumer channels reconcile their slots with this one rule.
//
//   'drop' | 'pending' — as republishDecision
//   'restart'          — supersede the slot from byte 0
//   'keep'             — nothing changed under this slot
export function activeSlotAction (inflightHash, state, sourceSeq) {
  const decision = republishDecision(inflightHash, state, sourceSeq)
  if (decision !== 'continue') return decision
  return supersedeDecision(inflightHash, state?.contentHash) === 'restart' ? 'restart' : 'keep'
}
