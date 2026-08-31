// What the owner's folder-scan notice says, given the worker's index status
// (owned-folder:index-status / event:owned-folder-index-progress).
//
// This counts the SCAN — the publish scheduler's queue depth — not the rows on screen. FolderTree's
// "N adding" badge counts rows whose status is publishing/preparing, and the two legitimately
// disagree: a queued file has no catalog entry yet, so it has no row to count. That gap is the whole
// reason this notice exists, so the numbers must never be presented as the same measurement.
//
// `adding` and `bytesQueued` are PUBLISH work only. The queue carries retires too — a delete is
// enqueued with the departing file's size — and counting those made removing a folder read as
// "Adding 300 files to this folder", the same class of mislabelling the indexing pills just fixed.

const count = (n) => (Number.isFinite(n) && n > 0 ? n : 0)

// The mount carries the durable pause. A paused index has an EMPTY queue — pausing drops it, and
// rebuilding it costs one walk because a published file is never re-hashed — so `paused` is
// deliberately independent of `active`: a paused folder reports the same zero a finished one does,
// and only the mount tells them apart.
export function deriveIndexSummary (status, mount) {
  const files = count(status?.adding)
  const paused = !!mount?.indexPaused
  // The scan's first phase walks the disk and fills no queue, so `adding` is 0 for the whole of it
  // — minutes on a large folder, during which the notice would otherwise show nothing and offer no
  // way to stop. That is exactly when a user reaches for one, so the phase counts as active.
  const scanning = !paused && !!mount?.scanning
  return {
    active: files > 0 || scanning,
    scanning: scanning && files === 0,
    paused,
    files,
    // Already publish-only and already dropped when an item starts, so this is what is still
    // WAITING to be read; the running file's own bytes are on its row's bar.
    bytesQueued: files > 0 ? count(status?.bytesQueued) : 0,
  }
}
