// Forensic record of every leftover sweep: what it deleted, or why it refused to. The sweep is the
// only path that destroys user data with no user action behind it; this is what makes a boot where
// spaces went missing reconstructable, read through diagnostics:export. Kept in `reclaim-meta` (an
// existing at-rest-encrypted LOCAL_BEE_NAMES bee, already in the sweep's own wanted set), so it adds
// no core for the sweep to be wrong about. Not an audit row: contract/audit-kinds.js excludes
// `storage.cleanup` as housekeeping, and that stands.
//
// Entry (written by leftover.js purgeLeftovers, one per sweep):
//   { at, refused: <decideSweep reason> | null, targets, totalCores, gaps: [{ stage, detail }],
//     categories: ('profiles' | 'catalogs' | 'orphanDrives')[], purged, purgedDks?: dkHex[] }
//   A refused sweep carries its gaps and purged: 0; a sweep that ran carries purgedDks. Gaps are
//   the scan's own, either way: a sweep with nothing to delete is allowed on a scan that may
//   still have been incomplete, and journaling that as [] would report a clean scan.
// Keys in `reclaim-meta`: purge/<at, 16 digits>-<seq, 4 digits> (this journal, chronological) and
// overlay-index-compacted (worker/sweeps.js's last-compaction stamp).
import { createLocalBee } from '../core/store.js'
import { createLogger } from '../core/logger.js'
import { prefixRange } from '../core/bee-keys.js'

const log = createLogger('sweep-journal')
const PREFIX = 'purge/'
const KEEP = 50

// Zero-padded so the bee's lexicographic order is chronological, and counter-suffixed so two
// sweeps inside one millisecond cannot collide on a key.
let seq = 0
const journalKey = (at) => PREFIX + String(at).padStart(16, '0') + '-' + String(seq++).padStart(4, '0')

export async function recordSweep (entry) {
  const bee = createLocalBee('reclaim-meta')
  try {
    await bee.ready()
    await bee.put(journalKey(Date.now()), { at: Date.now(), ...entry })
    const keys = []
    for await (const node of bee.createReadStream(prefixRange(PREFIX))) keys.push(node.key)
    for (const key of keys.slice(0, Math.max(0, keys.length - KEEP))) await bee.del(key)
  } catch (err) {
    // Never throws. A journal failure must not be the thing that aborts a sweep — or, worse, that
    // makes a caller retry one.
    log.warn('could not record the sweep:', err.message)
  } finally {
    try { await bee.close() } catch {}
  }
}

export async function listRecentSweeps (limit = 20) {
  const bee = createLocalBee('reclaim-meta')
  const out = []
  try {
    await bee.ready()
    for await (const node of bee.createReadStream({ ...prefixRange(PREFIX), reverse: true })) {
      out.push(node.value)
      if (out.length >= limit) break
    }
  } catch (err) {
    log.warn('could not read the sweep journal:', err.message)
  } finally {
    try { await bee.close() } catch {}
  }
  return out
}
