// Replaced records: what each local bee stores beyond what a fresh copy of its live entries would
// hold, and the worker half of "Free up". Measuring streams every bee, so it runs on the sweeps'
// schedule and on request, one at a time, and the result is kept in reclaim-meta for every read
// between. The rewrite that frees the bytes is the boot pass's (local-bee-rewrite.js).
/** @import { FreeUpResult } from '../contract/responses.js' */
import { createLocalBee } from '../core/store.js'
import { createLogger } from '../core/logger.js'
import { compactionIdle } from './compaction.js'
import { measureLocalBees, requestLocalBeeRewrite } from './local-bee-rewrite.js'
import { UNMEASURED_OVERHEAD, requestedRewriteDue } from './local-bee-rules.js'

/**
 * @typedef {{ name: string, historyBytes: number, rewritable: boolean }} BeeHistory
 * @typedef {{ measuredAt: number, bees: BeeHistory[] }} StorageHistory
 */

const log = createLogger('storage-history')
const HISTORY_KEY = 'storage-history'

let measuring = null

// Concurrent callers share the measurement in flight. It waits out a queued compaction, so it reads
// the store a reclaim has just shrunk.
/** @returns {Promise<StorageHistory>} */
export function measureHistory() {
  measuring ??= runMeasure().finally(() => { measuring = null })
  return measuring
}

// "Free up": the index compaction runs now; bees holding history over the requested bar are named for
// the next boot's rewrite, so the caller restarts the worker when any were.
/** @returns {Promise<FreeUpResult>} */
export async function freeUpStorage() {
  const { compactOverlayIndex } = await import('../transfer/overlay/overlay-maintenance.js')
  await compactOverlayIndex()
  const requested = [...await measureLocalBees()].filter(([, bee]) => rewritable(bee)).map(([name]) => name)
  if (requested.length) await requestLocalBeeRewrite(requested)
  return { restartRequired: requested.length > 0, requested }
}

// The last measurement, or null when there is none this build can read: the store is shared with
// other builds, and a failed read must not take the rest of the Storage screen with it.
/** @returns {Promise<StorageHistory | null>} */
export async function readHistory() {
  const bee = createLocalBee('reclaim-meta')
  try {
    await bee.ready()
    const value = (await bee.get(HISTORY_KEY))?.value
    return isHistory(value) ? value : null
  } catch (err) {
    log.warn('stored history measurement unreadable:', err.message)
    return null
  } finally {
    try { await bee.close() } catch {}
  }
}

async function runMeasure() {
  await compactionIdle()
  const bees = [...await measureLocalBees()].map(([name, bee]) => ({ name, historyBytes: historyOf(bee), rewritable: rewritable(bee) }))
  const history = { measuredAt: Date.now(), bees }
  const bee = createLocalBee('reclaim-meta')
  try {
    await bee.ready()
    await bee.put(HISTORY_KEY, history)
  } finally {
    try { await bee.close() } catch {}
  }
  return history
}

const overheadOf = (bee) => bee.overhead ?? UNMEASURED_OVERHEAD

// A fresh copy holds the live bytes times the bee's overhead; the rest is history. A capped scan
// knows no upper bound for live, so it claims none.
function historyOf(bee) {
  if (bee.capped) return 0
  return Math.max(0, bee.coreBytes - Math.round(bee.liveBytes * overheadOf(bee)))
}

function rewritable(bee) {
  return !bee.capped && requestedRewriteDue({ ...bee, overhead: overheadOf(bee) })
}

/** @param {Partial<StorageHistory> | null | undefined} value @returns {value is StorageHistory} */
function isHistory(value) {
  if (!value || !Number.isFinite(value.measuredAt) || !Array.isArray(value.bees)) return false
  return value.bees.every((b) => b && typeof b.name === 'string' && Number.isFinite(b.historyBytes) && typeof b.rewritable === 'boolean')
}
