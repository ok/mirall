// RocksDB compaction — returning tombstoned blocks to the OS.
//
// core.clear(), core.truncate() and a core purge only mark blocks deleted in the shared store; the
// bytes return to disk when a compaction with blob GC runs. Every reclaim path ends in compactStore().
//
// Every run is chained onto the last. Two overlapping compactions can strand a blob permanently:
// a background pass that drops a swept block's delete tombstone before the blob-GC pass accounts
// its garbage leaves an orphaned blob file no later compaction can reclaim.

import { getStore } from '../core/store.js'
import { FORCED_COMPACTION } from '../contract/compaction.js'
import { createLogger } from '../core/logger.js'

const log = createLogger('compaction')

const SETTLE_MS = 250

let compactionTail = Promise.resolve()

/** @internal parks the tail so the bounded wait in settleCompaction is observable. */
export function _compactStoreForTests(makeTail) {
  compactionTail = makeTail()
}

function chainCompaction(opts, label) {
  const run = compactionTail.catch(() => {}).then(async () => {
    const db = getStore()?.storage?.db
    if (!db) return
    const t0 = Date.now()
    log.info('compaction start:', label)
    try {
      await db.flush()
      await db.compactRange(null, null, opts)
    } finally {
      log.info('compaction done:', label, 'in', Date.now() - t0, 'ms')
    }
  })
  compactionTail = run
  return run
}

// Forced full-range blob-GC compaction. Always runs.
export function compactStore() {
  return chainCompaction(FORCED_COMPACTION, 'forced full-range')
}

// Resolves once every compaction queued so far has finished, whatever its outcome.
export function compactionIdle() {
  return compactionTail.catch(() => {})
}

// Waits out an in-flight compaction, bounded. A compaction reads cores the durable tier closes
// right after teardown, but it runs under the runtime tier's shared budget — a full-range pass the
// user just started would otherwise spend the whole budget and skip every subsystem behind it.
export async function settleCompaction() {
  await Promise.race([
    compactionTail.catch(() => {}),
    new Promise((resolve) => { const t = setTimeout(resolve, SETTLE_MS); t.unref?.() }),
  ])
  compactionTail = Promise.resolve()
}
