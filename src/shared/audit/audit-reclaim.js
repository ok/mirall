// Bounding the log: the recurring prune and the user's explicit purge.
//
// Prune bounds the row count, not the bytes. A Hyperbee `del` appends a tombstone, and a range
// core.clear() is unsafe — Hyperbee interleaves index nodes with value blocks, so a cleared prefix
// can drop a node the live index still points at (measured: a fresh open reads zero rows and stalls
// on a missing block). Growth is bounded by `maxEntries`, with ~1KB of residue per pruned row.
//
// Purge is the ONE place bytes are reclaimed: truncateLog() empties the core in place and a
// whole-store compaction returns the blocks to the filesystem. That pass is affordable only because
// a purge is a deliberate, confirmed, one-off user action — never run it on the prune path. Purge
// writes back `config` (a preference) and the `seen/` watermarks (dropping them replays every peer's
// history) and drops the observed states, so the standing fact is restated once after a wipe.
import { createLogger } from '../core/logger.js'
import { auditBee, flushAudit, getAuditConfig, newestSeq, oldestSeq, truncateLog } from './audit-log.js'
import { ageCutoff, ageWatermark, pruneUpTo } from './audit-retention.js'
import { readSeenVersions, writeSeenVersions } from './audit-watch-state.js'
import { CONFIG_KEY, evtRange, indexKeyOf } from './audit-keys.js'
import { compactStore } from '../storage/compaction.js'

const log = createLogger('audit-reclaim')

// Deletes per batch flush, so a first prune over a long backlog does not hold every op in memory.
const DELETE_BATCH = 500

async function* records(bee) {
  for await (const entry of bee.createReadStream(evtRange())) {
    if (entry.value) yield entry.value
  }
}

async function deleteUpTo(bee, upTo) {
  let removed = 0
  let batch = bee.batch()
  for await (const entry of bee.createReadStream(evtRange(upTo + 1))) {
    await batch.del(entry.key)
    if (entry.value) await batch.del(indexKeyOf(entry.value))
    removed += 1
    if (removed % DELETE_BATCH === 0) {
      await batch.flush()
      batch = bee.batch()
    }
  }
  await batch.flush()
  return removed
}

export async function pruneAudit({ now = Date.now() } = {}) {
  const bee = auditBee()
  if (!bee) return { removed: 0 }
  await flushAudit()
  const newest = await newestSeq()
  if (newest < 0) return { removed: 0 }

  const { retentionDays, maxEntries } = getAuditConfig()
  const cutoff = ageCutoff(now, retentionDays)
  const seqAtOrBelowAge = cutoff == null ? null : await ageWatermark(records(bee), cutoff)
  const upTo = pruneUpTo({ retentionDays, maxEntries, newestSeq: newest, seqAtOrBelowAge })
  if (upTo == null || upTo < 0) return { removed: 0 }

  const removed = await deleteUpTo(bee, upTo)
  if (removed) log.info('pruned', removed, 'rows up to seq', upTo)
  return { removed }
}

export async function purgeAudit() {
  const bee = auditBee()
  if (!bee) return { purged: 0 }
  await flushAudit()
  const oldest = await oldestSeq()
  const purged = oldest < 0 ? 0 : (await newestSeq()) - oldest + 1
  const seen = await readSeenVersions()
  const keptConfig = getAuditConfig()

  // A row recorded during those reads is racing a total wipe, so losing it is the right outcome.
  await truncateLog()
  await bee.put(CONFIG_KEY, keptConfig)
  await writeSeenVersions(seen)

  try {
    await compactStore()
  } catch (err) { log.warn('compaction after purge failed:', err.message) }

  log.info('purged', purged, 'rows and reclaimed the core')
  return { purged }
}
