// Last-resort backstop for the Bare worker. A single unhandled rejection / uncaught
// exception in any fire-and-forget data-layer task — a corestore replication callback
// serving a half-written ("zombie") core by discovery key, a peer handshake, a timer —
// must not abort the worker and take the whole data layer down with it (the Electron main
// process carries the same guard for its side). Log loudly and keep serving.
// Returns a disposer (used by tests; production installs once for the worker's lifetime).
export function installCrashBackstop(log) {
  const onUncaught = (err) => log.error('uncaughtException (worker kept alive):', err && (err.stack || err.message || err))
  const onRejection = (reason) => log.error('unhandledRejection (worker kept alive):', reason && (reason.stack || reason.message || reason))
  Bare.on('uncaughtException', onUncaught)
  Bare.on('unhandledRejection', onRejection)
  return () => {
    Bare.removeListener('uncaughtException', onUncaught)
    Bare.removeListener('unhandledRejection', onRejection)
  }
}
