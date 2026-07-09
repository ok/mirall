// Pure status derivation for a share-file row, given the durable pending row
// and whether a transfer is currently in flight for it. Shared by the
// share:list-files and loose/foreign status paths so the rule stays consistent.
export function pausedStatusFor({ pendingRow, isActive, ownerOnline }) {
  if (!pendingRow || isActive) return null
  return {
    status: ownerOnline ? 'paused-interrupted' : 'paused-offline',
    pendingBytes: pendingRow.bytesTransferred || 0,
  }
}

// The reason carried on a transfer-paused event, following the same presence predicate as
// pausedStatusFor: a reachable owner means the pause is an interruption (content evicted,
// re-indexing, holder churn), not an offline owner.
export function pauseReasonFor(ownerOnline) {
  return ownerOnline ? 'interrupted' : 'offline'
}

// A null-contentHash entry is advertised before hashing finished → 'preparing', but only while
// the owner is reachable: once offline the placeholder is frozen (no completing/tombstoning
// append can arrive), so it degrades to 'unavailable' like any other file from an offline owner.
export function unhashedStatusFor(ownerOnline) {
  return ownerOnline ? 'preparing' : 'unavailable'
}
