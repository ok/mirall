// RocksDB compaction — returning tombstoned blocks to the OS.
//
// core.clear() / drive.clearAll() only mark blocks deleted in the shared store; the bytes are not
// reclaimed from disk until a compaction with blob GC runs. Leave-space, clear-peer-cache and the
// reclaim sweep all depend on this to actually shrink on-disk usage.
//
// Every run is chained onto the last. Two overlapping compactions can strand a blob permanently:
// a background pass that drops a swept block's delete tombstone before the blob-GC pass accounts
// its garbage leaves an orphaned blob file no later compaction can reclaim.

import { getStore } from '../core/store.js'
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
    log.info('PROBE compaction start:', label)
    try {
      await db.flush()
      await db.compactRange(null, null, opts)
    } finally {
      log.info('PROBE compaction done:', label, 'in', Date.now() - t0, 'ms')
    }
  })
  compactionTail = run
  return run
}

// Forced full-range blob-GC compaction — used only by the rare user-initiated reclaim paths
// (leave-space, clear-cache, reclaim sweep). Always runs. `exclusive` blocks background
// compactions for the duration, which is what closes the tombstone race described above.
export function compactStore() {
  return chainCompaction({
    exclusive: true,
    blobGarbageCollectionPolicy: 1,
    blobGarbageCollectionAgeCutoff: 1.0,
    bottommostLevelCompaction: 2,
  }, 'forced full-range')
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
