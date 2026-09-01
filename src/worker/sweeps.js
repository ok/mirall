// The worker's periodic backstops. Each one is a missed-event catch-up, never the primary path:
// the live signals (chokidar unlinks, invite expiry checks, the audit retention read) already
// enforce the same thing, so a tick that fails or never runs only defers cleanup.
//
// They were three top-level `setInterval`s in the worker entry — armed at load, held in
// module-level consts that nothing read, and still firing into closed cores after shutdown.
import { Subsystem } from '../shared/core/subsystem.js'
import { isInPlaceFilesEnabled } from '../shared/core/runtime-config.js'
import { sweepBackends } from '../shared/transfer/content-backends.js'
import { sweepLoosePresence } from '../shared/transfer/loose-overlay.js'
import { listSpaces } from '../shared/spaces/space.js'
import { createLocalBee } from '../shared/core/store.js'
import { sweepExpiredInvites } from '../shared/spaces/profile.js'
import { pruneAudit } from '../shared/audit/audit-log.js'

const PRESENCE_SWEEP_INTERVAL_MS = 60_000
const INVITE_SWEEP_INTERVAL_MS = 60 * 60 * 1000
const AUDIT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000
const INDEX_COMPACT_INTERVAL_MS = 6 * 60 * 60 * 1000
// Long enough that it never competes with the initial publish scan, short enough that a session
// that lasts an afternoon still pays its due pass.
const INDEX_COMPACT_BOOT_DELAY_MS = 5 * 60 * 1000
const LAST_COMPACT_KEY = 'overlay-index-compacted'

// The overlay's local index keeps a chunk map per content hash, and a republish supersedes the old
// hash without retiring its map. Compaction rode the "Free up space" action; with that gone it
// needs a cadence of its own — and a bare interval is not one. Desktop sessions are routinely
// shorter than the interval, so a process that never reaches its first tick would never compact at
// all, and the next launch would restart the clock from zero. The last run is therefore persisted
// and the schedule is "due?", not "6h since this process started".
export async function compactIndexIfDue() {
  const bee = createLocalBee('reclaim-meta')
  try {
    await bee.ready()
    const last = (await bee.get(LAST_COMPACT_KEY))?.value?.at ?? 0
    if (Date.now() - last < INDEX_COMPACT_INTERVAL_MS) return false
    const { compactOverlayIndex } = await import('../shared/transfer/backends/overlay/overlay-backend.js')
    await compactOverlayIndex()
    await bee.put(LAST_COMPACT_KEY, { at: Date.now() })
    return true
  } finally {
    try { await bee.close() } catch {}
  }
}

// Prune our own expired invite links (reusable-until-expiry records are never consumed).
// Best-effort: enforcement is by timestamp regardless, so a missed run only defers cleanup.
async function sweepAllExpiredInvites() {
  for (const s of await listSpaces()) await sweepExpiredInvites(s.spaceId)
}

export class Sweeps extends Subsystem {
  constructor(name, deps) { super(name, deps); this.require('auditLog') }

  async _open() {
    const { log } = this

    // Backstop for catalog-backed shares: tombstone catalog entries whose source vanished
    // (chokidar unlinks cover the live case; this catches missed events).
    this.timers.setInterval(() => {
      // Overlay shares get a missed-unlink backstop via the backend fan-out (no-ops when overlay
      // is off / there are no overlay shares).
      sweepBackends().catch((err) => log.debug('overlay presence sweep failed:', err.message))
      if (isInPlaceFilesEnabled()) sweepLoosePresence().catch((err) => log.debug('loose presence sweep failed:', err.message))
    }, PRESENCE_SWEEP_INTERVAL_MS)

    this.timers.setInterval(() => {
      sweepAllExpiredInvites().catch((err) => log.debug('invite sweep failed:', err.message))
    }, INVITE_SWEEP_INTERVAL_MS)
    sweepAllExpiredInvites().catch((err) => log.debug('invite sweep failed:', err.message))

    const compact = () => compactIndexIfDue().catch((err) => log.debug('overlay index compaction failed:', err.message))
    this.timers.setTimeout(compact, INDEX_COMPACT_BOOT_DELAY_MS)
    this.timers.setInterval(compact, INDEX_COMPACT_INTERVAL_MS)

    // The prune reads and writes the audit bee, so it runs only when that bee actually opened —
    // a failed AuditLog._open must not turn every daily tick into a rejection.
    if (this.deps.auditLog.opened) {
      pruneAudit().catch((err) => log.warn('audit prune failed:', err.message))
      this.timers.setInterval(() => {
        pruneAudit().catch((err) => log.debug('audit prune failed:', err.message))
      }, AUDIT_PRUNE_INTERVAL_MS)
    }
  }
}
