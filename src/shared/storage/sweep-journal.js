// Forensic record of every leftover sweep: what it deleted, or why it refused to.
//
// The sweep is the only path in the app that destroys user data with no user action behind it, and
// until now it left nothing behind but a log line that a release build discards. This is the record
// that makes a boot where spaces went missing reconstructable.
//
// Kept in `reclaim-meta` — an existing LOCAL_BEE_NAMES bee (at-rest encrypted, already in the
// sweep's own wanted set), so this adds no new core and therefore no new surface for the sweep to
// be wrong about itself.
//
// Deliberately NOT an audit row: contract/audit-kinds.js excludes `storage.cleanup` as app
// housekeeping rather than "which user did what in a space", and that decision stands. This answers
// a different question — "what did the sweep do on boot N" — and is read through diagnostics:export.
import { createLocalBee } from '../core/store.js'
import { createLogger } from '../core/logger.js'

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
    for await (const node of bee.createReadStream({ gte: PREFIX, lt: PREFIX + '\xff' })) keys.push(node.key)
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
    for await (const node of bee.createReadStream({ gte: PREFIX, lt: PREFIX + '\xff', reverse: true })) {
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
