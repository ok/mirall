// The inotify ceiling, accounted for every watch tree in this process. Past
// fs.inotify.max_user_watches a new watch is a dead handle with no throw and no error event, so a
// caller that does not count cannot tell a watched directory from an unwatched one. The ceiling is
// per USER, not per process, so what this counts is a lower bound on what the kernel holds and a
// reserve is left for everything else running.
import fs from 'bare-fs'
import os from 'bare-os'

const LIMIT_PATH = '/proc/sys/fs/inotify/max_user_watches'
// Handles held back for the rest of the system. A tree that spends the last of a shared ceiling
// breaks every other program that watches files, and gets nothing that the reconcile would not.
const RESERVE = 512

let cachedLimit = null
let armed = 0

// 0 means "no accounted ceiling": every platform but linux watches without an inotify budget, and a
// kernel whose /proc entry cannot be read is not a ceiling that can be honoured.
function readLimit() {
  if (os.platform() !== 'linux') return 0
  try {
    const n = Number(fs.readFileSync(LIMIT_PATH, 'utf8').trim())
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

// Read once and cached: the ceiling is a boot-time kernel setting, and a file read per arm would
// cost more than the accounting it feeds. `watchBudgetFacts` is how a caller sees it.
function watchBudgetLimit() {
  if (cachedLimit === null) cachedLimit = readLimit()
  return cachedLimit
}

// True when the handle is granted and charged. A refusal is the caller's signal to report the
// directory as unwatched rather than arm a watcher that will never fire.
export function takeWatch() {
  const limit = watchBudgetLimit()
  if (limit > 0 && armed + 1 > limit - RESERVE) return false
  armed += 1
  return true
}

export function releaseWatch() {
  if (armed > 0) armed -= 1
}

export function watchBudgetFacts() {
  return { armed, limit: watchBudgetLimit(), reserve: RESERVE }
}

/**
 * The one reset. Module state with a reset is a registry; the same state without one is a shutdown
 * latch, so this is the only way the count returns to zero.
 * @param {number | null} [limitOverride] test seam: the ceiling to account against, so the refusal
 *   path is driven on a box whose kernel ceiling cannot be lowered without root
 */
export function resetWatchBudget(limitOverride = null) {
  armed = 0
  cachedLimit = limitOverride
}
