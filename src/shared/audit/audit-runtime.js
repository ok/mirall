// The audit log and the activity feed as lifecycle resources. They open and close apart: the
// notifications the feed carries, presence among them, must not depend on the log's bee starting.
//
// It lives in its own module rather than in audit-log.js because network-watch.js imports
// audit-log.js: wiring the two together from inside audit-log.js would close a cycle through the
// module every instrumentation call site already imports.
import { Subsystem } from '../core/subsystem.js'
import { initAuditLog, closeAuditLog } from './audit-log.js'
import { setActivityEmitter } from './activity-feed.js'
import { initNetworkWatch, resetNetworkWatch } from './network-watch.js'

export class AuditLog extends Subsystem {
  async _open() {
    // initAuditLog assigns the module-level bee BEFORE awaiting ready(), so a throw after that
    // point would leave isAuditReady() true over a half-open bee — record() would keep appending
    // into it and the Corestore session would leak, while the root logged "unavailable". Undo it
    // before propagating, so a failed start really does degrade to no rows.
    try {
      await initAuditLog({ installId: this.deps.installId ?? null })
    } catch (err) {
      await closeAuditLog().catch(() => {})
      throw err
    }
  }

  async _close() {
    await closeAuditLog()
  }
}

// The connectivity watch writes its rows through record() like any call site, so it runs whether or
// not the log is open: its presence rows are notifications too.
export class ActivityFeed extends Subsystem {
  constructor(name, deps) { super(name, deps); this.require('ipc') }

  async _open() {
    setActivityEmitter((activity) => this.deps.ipc.emit('event:activity', activity))
    initNetworkWatch({
      emit: () => this.deps.ipc.emit('event:audit-updated', {}),
      peerDwellMs: this.deps.peerDwellMs ?? 0,
      relayDwellMs: this.deps.relayDwellMs ?? 0,
      // The watch's dwell timeouts re-arm themselves, so they belong to this subsystem's set
      // rather than to the call that happened to start them.
      timers: this.timers,
    })
  }

  // Symmetric with _open: the watch arms its dwell timeouts through this subsystem's set, and the
  // only other caller of resetNetworkWatch is destroySwarm — which boot({ swarm: false }) never
  // reaches. This clears the two handles; the set itself is closed on every ending by the base.
  async _close() {
    resetNetworkWatch()
    setActivityEmitter(null)
  }
}
