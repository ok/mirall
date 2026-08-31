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

export function deriveIndexSummary (status) {
  const files = count(status?.adding)
  return {
    active: files > 0,
    files,
    // Already publish-only and already dropped when an item starts, so this is what is still
    // WAITING to be read; the running file's own bytes are on its row's bar.
    bytesQueued: files > 0 ? count(status?.bytesQueued) : 0,
  }
}
