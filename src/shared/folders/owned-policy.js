// The owner-side scan's pure judgements: how a share is keyed, whether a file on disk needs
// publishing, and which of two I/O faults a pass reports when it has seen both.
import { CODES } from '../contract/errors.js'

// Every owner-side map is keyed by this pair — the pass registry, the fault ledger, the share
// cache, the catch-up timers and the supervisor's units. One spelling, so a grep for a key finds
// every holder of one.
export function ownedKey(spaceId, shareId) {
  return spaceId + ':' + shareId
}

// Longer than chokidar's awaitWriteFinish stabilityThreshold, so a catch-up diff that runs
// mid-copy leaves the file to the watcher instead of reading it and reverting.
export const SCAN_SETTLE_MS = 2000

// Size+mtime is the "unchanged" signal. A deep pass distrusts mtimes (a relocated tree has fresh
// ones everywhere) and enqueues regardless; the publish then settles equality by hash. A catch-up
// pass leaves a fresh, never-published file to the watcher's awaitWriteFinish instead of reading
// it mid-copy; `age >= 0` keeps a future mtime (clock skew) from deferring it forever.
export function publishVerdict(prev, info, { deep = false, deferFresh = false, now = Date.now(), settleMs = SCAN_SETTLE_MS } = {}) {
  if (deep) return 'publish'
  if (prev && prev.size === info.size && prev.mtime === info.mtime && prev.contentHash) return 'unchanged'
  if (deferFresh && !prev) {
    const age = now - info.mtime
    if (age >= 0 && age < settleMs) return 'defer'
  }
  return 'publish'
}

// A full disk outranks a permission fault: it stops the whole device, not one subtree. An
// unclassifiable failure (null) never displaces what the pass already holds.
export function worsePassFault(current, next) {
  if (current === CODES.TRANSFER_DISK_FULL) return current
  return next ?? current ?? null
}
