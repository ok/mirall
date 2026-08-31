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

// Consumer-side row status for a catalog entry we hold no copy of, as an ORDER of rules. The
// unhashed check sits ahead of the pending-row ones because the republish park deliberately keeps
// a (zeroed) pending row through the owner's re-hash: read paused-first, that wait surfaced as a
// "Paused" row nobody paused, offering Resume against a hash that no longer exists.
//
// It yields to a row that still holds PARTIAL BYTES and an owner who has gone offline: that wait
// cannot resolve until they return, and 'unavailable' would strip the partial's Discard and leave
// the bytes on disk unmanageable. While the owner is reachable the wait wins either way — the
// materialized-hash append restarts the download, and the stale partial goes with it.
export function consumerRowStatusFor({ hashed, isActive, pendingRow, ownerOnline }) {
  if (isActive) return { status: 'downloading', pendingBytes: pendingRow?.bytesTransferred || 0 }
  const partial = pendingRow?.bytesTransferred > 0
  if (!hashed && (ownerOnline || !partial)) return { status: unhashedStatusFor(ownerOnline) }
  if (pendingRow?.errorCode) return { status: 'error', errorCode: pendingRow.errorCode }
  const paused = pausedStatusFor({ pendingRow, isActive, ownerOnline })
  if (paused) return { status: paused.status, pendingBytes: paused.pendingBytes }
  return { status: ownerOnline ? 'remote' : 'unavailable' }
}
