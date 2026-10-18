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
// Keys in `reclaim-meta`: purge/<at, 16 digits>-<seq, 4 digits> (this journal, chronological),
// removal/… (removal-evidence.js), overlay-index-compacted (worker/sweeps.js's last-compaction stamp) and storage-history
// (storage-history.js's last measurement).
import { createLogger } from '../core/logger.js'
import { journalKey, withReclaimMeta, readJournal } from './reclaim-journal.js'

const log = createLogger('sweep-journal')
const PREFIX = 'purge/'
const KEEP = 50

// Never throws. A journal failure must not be the thing that aborts a sweep — or, worse, that makes
// a caller retry one.
export async function recordSweep(entry) {
  await withReclaimMeta(async (bee) => {
    const at = Date.now()
    await bee.put(journalKey(PREFIX, at), { at, ...entry })
    const keys = (await readJournal(bee, PREFIX)).map((node) => node.key)
    for (const key of keys.slice(0, Math.max(0, keys.length - KEEP))) await bee.del(key)
  }, { log, failure: 'could not record the sweep:', fallback: undefined })
}

export async function listRecentSweeps(limit = 20) {
  return withReclaimMeta(async (bee) => (await readJournal(bee, PREFIX, { reverse: true, limit })).map((node) => node.value), {
    log, failure: 'could not read the sweep journal:', fallback: [],
  })
}
