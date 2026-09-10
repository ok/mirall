// Last-resort backstop for the Bare worker: an unhandled rejection or uncaught exception in a
// fire-and-forget data-layer task (a replication callback serving a zombie core, a peer handshake,
// a timer) is logged and the worker keeps serving — the same guard Electron main carries for its
// side. Returns a disposer (tests; production installs once).
//
// Alive is right for an ISOLATED fault and wrong for a stream of them: a subsystem throwing out of
// its own state machine stays wedged silently. So faults are counted against a window — a RATE,
// not a total, because a long session legitimately accumulates isolated faults over hours — and a
// worker over the threshold exits, handing recovery to the renderer's respawn supervisor.
const DEFAULT_WINDOW_MS = 60_000
const DEFAULT_THRESHOLD = 10

export function installCrashBackstop(log, {
  windowMs = DEFAULT_WINDOW_MS,
  threshold = DEFAULT_THRESHOLD,
  isArmed = () => true,
  onUnstable = null,
  now = Date.now,
} = {}) {
  let stamps = []
  let escalated = false

  function record(kind, detail) {
    log.error(`${kind} (worker kept alive):`, detail)
    const t = now()
    stamps.push(t)
    // Bounded by construction: anything older than the window is dropped on every record, so the
    // array can never hold more than one window's worth of arrivals.
    stamps = stamps.filter((s) => t - s <= windowMs)
    if (stamps.length < threshold || escalated) return
    // Not armed = boot has not finished, or a shutdown is already running. NOT latched: a boot-time
    // storm of background core opens must not kill the worker (that would turn "slow to start"
    // into "will not start", which the renderer's give-up budget makes permanent); a storm that
    // continues past boot escalates on its next fault, because the stamps keep rolling.
    if (!onUnstable || !isArmed()) return
    // Latch: escalation fires exactly once. Without it every subsequent throw re-enters the exit
    // path, and the shutdown that path runs would race itself.
    escalated = true
    log.error(`${stamps.length} uncaught errors in ${Math.round(windowMs / 1000)}s — worker is unstable, exiting for respawn`)
    onUnstable()
  }

  const onUncaught = (err) => record('uncaughtException', err && (err.stack || err.message || err))
  const onRejection = (reason) => record('unhandledRejection', reason && (reason.stack || reason.message || reason))
  Bare.on('uncaughtException', onUncaught)
  Bare.on('unhandledRejection', onRejection)
  const dispose = () => {
    Bare.removeListener('uncaughtException', onUncaught)
    Bare.removeListener('unhandledRejection', onRejection)
  }
  // How close this worker is to the threshold. The count IS the health signal the escalation acts
  // on, so exposing it is what lets a test assert the window prunes rather than assert the process
  // merely survived, and it is the number a diagnostics report would want.
  dispose.faultsInWindow = () => stamps.length
  return dispose
}
