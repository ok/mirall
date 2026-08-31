// What the owner's folder-scan notice says, given the worker's index status
// (owned-folder:index-status / event:owned-folder-index-progress).
//
// This counts the SCAN — the publish scheduler's queue depth — not the rows on screen. FolderTree's
// "N adding" badge counts rows whose status is publishing/preparing, and the two legitimately
// disagree: a queued file has no catalog entry yet, so it has no row to count. That gap is the whole
// reason this notice exists, so the numbers must never be presented as the same measurement.
//
// `bytesQueued` covers the files still WAITING (publish-scheduler's bytesForShare drops an item from
// the queue when it starts), so it is reported as what is left to read, never as a total.

const count = (n) => (Number.isFinite(n) && n > 0 ? n : 0)

export function deriveIndexSummary (status) {
  const running = count(status?.running)
  const queued = count(status?.queued)
  const files = running + queued
  return {
    active: files > 0,
    files,
    running,
    queued,
    // Only shown when there is something still waiting; the running file's own bytes ride the
    // per-row progress bar, so adding them here would double-count what the rows already show.
    bytesQueued: queued > 0 ? count(status?.bytesQueued) : 0,
  }
}
