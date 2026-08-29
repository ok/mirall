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
import { sweepExpiredInvites } from '../shared/spaces/profile.js'
import { pruneAudit } from '../shared/audit/audit-log.js'

const PRESENCE_SWEEP_INTERVAL_MS = 60_000
const INVITE_SWEEP_INTERVAL_MS = 60 * 60 * 1000
const AUDIT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000

// Prune our own expired invite links (reusable-until-expiry records are never consumed).
// Best-effort: enforcement is by timestamp regardless, so a missed run only defers cleanup.
async function sweepAllExpiredInvites() {
  for (const s of await listSpaces()) {
    if (s.schemaVersion === 2) await sweepExpiredInvites(s.spaceId)
  }
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
