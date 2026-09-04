// The audit log as a lifecycle resource: the bee and the connectivity watch that writes into it
// open together and close together.
//
// It lives in its own module rather than in audit-log.js because that module documents — and
// depends on — importing nothing but core/: network-watch.js imports audit-log.js, so wiring the
// two together from inside audit-log.js would close a cycle through the module every
// instrumentation call site already imports.
import { Subsystem } from '../core/subsystem.js'
import { initAuditLog, closeAuditLog } from './audit-log.js'
import { initNetworkWatch, resetNetworkWatch } from './network-watch.js'

export class AuditLog extends Subsystem {
  constructor(name, deps) { super(name, deps); this.require('ipc') }

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
    initNetworkWatch({
      emit: () => this.deps.ipc.emit('event:audit-updated', {}),
      peerDwellMs: this.deps.peerDwellMs ?? 0,
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
    await closeAuditLog()
  }
}
