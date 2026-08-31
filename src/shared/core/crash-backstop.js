// Last-resort backstop for the Bare worker. A single unhandled rejection / uncaught
// exception in any fire-and-forget data-layer task — a corestore replication callback
// serving a half-written ("zombie") core by discovery key, a peer handshake, a timer —
// must not abort the worker and take the whole data layer down with it (the Electron main
// process carries the same guard for its side). Log loudly and keep serving.
// Returns a disposer (used by tests; production installs once for the worker's lifetime).
//
// Keeping the worker alive is right for an ISOLATED fault and wrong for a stream of them: a
// subsystem throwing out of its own state machine stays wedged silently, and the folder simply
// stops syncing with nothing reporting it. So the count is tracked against a window, and a worker
// producing faults faster than the threshold exits instead — which hands recovery to the renderer's
// respawn supervisor, a mechanism that until now could only see an OOM or a deliberate exit.
//
// A rate rather than a total: a long session legitimately accumulates isolated recoverable faults
// over hours, so a total would eventually trip on a healthy worker.
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
    // Not armed = boot has not finished, or a shutdown is already running. Deliberately NOT
    // latched here: this is the one case where the backstop's original job still applies in full.
    // The whole reason it is installed before the first await is that a boot-time storm of
    // background core opens must not kill the worker — escalating there would turn "the app is
    // slow to start" into "the app will not start", and a boot-crash loop is exactly what the
    // renderer's give-up budget stops by leaving the app dead. A storm that continues past boot
    // escalates on its next fault, because the stamps keep rolling.
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
