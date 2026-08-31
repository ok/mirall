// The lifecycle base for every worker subsystem. A subsystem is constructed with its
// collaborators (`deps`) and does nothing until ready(); close() undoes exactly what _open did,
// in reverse. Timers go through `this.timers` so they die with the subsystem on EVERY close
// path — including a failed _open, which ReadyResource ends without ever running _close.
import ReadyResource from 'ready-resource'
import { createTimers } from './timers.js'
import { createLogger } from './logger.js'

export class Subsystem extends ReadyResource {
  constructor(name, deps = {}) {
    super()
    if (typeof name !== 'string' || !name) throw new Error('Subsystem: name is required')
    this.name = name
    this.deps = deps
    this.log = createLogger(name)
    this.timers = createTimers()
    this._stopping = false
    // The 'close' EVENT covers the path _close cannot: ReadyResource ends a FAILED _open by
    // running close() in the background WITHOUT ever calling _close, so anything armed before the
    // throw would otherwise be unreachable. It does not cover a _close that REJECTS — that
    // short-circuits both `closed = true` and the emit — which is why close() below also clears
    // in a finally. Two paths, because neither one alone reaches every ending.
    this.once('close', () => this.timers.close())
  }

  // The timers die with the subsystem whatever _close does. A _close that throws is still a
  // failure worth propagating (the lifecycle logs it), but it must not leave a live interval
  // behind — that is the one guarantee this base exists to give.
  async close() {
    this._stopping = true
    try {
      return await super.close()
    } finally {
      this.timers.close()
    }
  }

  // Open and not tearing down. A subsystem that can say more about whether it is still doing its
  // job overrides this; reporting is deliberately separate from any recovery, so a subsystem
  // nothing can restart still reports.
  health() {
    return { ok: !this.closed && !this.stopping, detail: null }
  }

  // A missing collaborator fails at construction — at boot, in the root, with the subsystem's
  // name — instead of as a `hook?.()` that never fires.
  require(...names) {
    for (const n of names) {
      if (this.deps[n] == null) throw new Error(`${this.name}: missing dep "${n}"`)
    }
    return this.deps
  }

  // True from the instant close() is called — the replacement for the hand-rolled "teardown is
  // closing cores, don't race it" flags. Async continuations check it before touching state.
  // ReadyResource assigns `this.closing` only after close() first suspends, which is inside
  // _close, so its own synchronous prefix would read a stale false; the flag above is set first.
  get stopping() { return this._stopping || this.closing !== null }
}

// The ordered registry the composition root uses: start() records what opened, close() closes it
// in reverse. One failure never skips the rest.
//
// `deadlineAt` is what keeps a bounded drain from starving the steps that follow it: several
// subsystems wait (bounded) for in-flight passes to bail, and those ceilings can sum past the
// caller's own hard deadline — after which the process is killed and everything downstream of the
// slow one never runs at all. A subsystem that overruns is abandoned, not awaited: its close()
// keeps going, and the process is exiting anyway.
export function createLifecycle({ log }) {
  const started = []
  return {
    async start(subsystem) {
      await subsystem.ready()
      started.push(subsystem)
      log.debug('started', subsystem.name)
      return subsystem
    },
    async close({ deadlineAt = 0 } = {}) {
      for (const subsystem of started.splice(0).reverse()) {
        const left = deadlineAt ? deadlineAt - Date.now() : 0
        try {
          if (!deadlineAt) await subsystem.close()
          else if (left <= 0) log.warn(subsystem.name, 'close skipped — shutdown budget spent')
          else {
            const timedOut = Symbol('timeout')
            const race = await Promise.race([
              subsystem.close().then(() => null),
              new Promise((resolve) => { const t = setTimeout(() => resolve(timedOut), left); t.unref?.() }),
            ])
            if (race === timedOut) log.warn(subsystem.name, 'close exceeded the shutdown budget — abandoned')
          }
        } catch (err) { log.warn(subsystem.name, 'close failed:', err.message) }
      }
    },
    get started() { return started.slice() },
    // `name` is spread last so a subsystem returning its own cannot shadow the row key.
    health() {
      return started.map((subsystem) => ({ ...subsystem.health(), name: subsystem.name }))
    },
  }
}
