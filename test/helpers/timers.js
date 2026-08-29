// Wraps the global timer functions and records every live handle with its creation stack, so a
// test can assert "nothing is armed" and name what is. Install it BEFORE the modules under test
// are imported — a timer armed at import is exactly what it exists to catch — and restore in
// teardown. Handles from before the shim, and from runtime internals (RocksDB, the store), are
// not ours: the stack filter keeps the count to src/shared and src/worker.
export function trackTimers () {
  const real = {
    setInterval: globalThis.setInterval,
    setTimeout: globalThis.setTimeout,
    clearInterval: globalThis.clearInterval,
    clearTimeout: globalThis.clearTimeout,
  }
  // Bare's default is 10 frames, and a timer armed deep under a library call can push every
  // src/ frame out of the capture — which would report a real leak as "not ours".
  const realStackLimit = Error.stackTraceLimit
  Error.stackTraceLimit = 60
  const live = new Map()
  globalThis.setInterval = (fn, ms, ...args) => {
    const t = real.setInterval(fn, ms, ...args)
    live.set(t, { kind: 'interval', ms, stack: new Error().stack })
    return t
  }
  globalThis.setTimeout = (fn, ms, ...args) => {
    const entry = { kind: 'timeout', ms, stack: new Error().stack }
    const t = real.setTimeout((...a) => { live.delete(t); fn(...a) }, ms, ...args)
    live.set(t, entry)
    return t
  }
  globalThis.clearInterval = (t) => { live.delete(t); return real.clearInterval(t) }
  globalThis.clearTimeout = (t) => { live.delete(t); return real.clearTimeout(t) }
  // "Ours" is the NEAREST caller below the shim, not any frame in the stack: a hyperswarm or
  // corestore timer armed synchronously under a src/ call has src/ frames further down and would
  // otherwise be counted as the data layer's own.
  const callerFrame = (e) => (e.stack || '').split('\n').slice(1).find((l) => !l.includes('test/helpers/timers.js')) || ''
  const ours = (e) => /src[/\\](shared|worker)[/\\]/.test(callerFrame(e))
  const pick = (kind) => [...live.values()].filter((e) => e.kind === kind && ours(e))
  return {
    intervals: () => pick('interval'),
    timeouts: () => pick('timeout'),
    describe: (list) => list.map((e) => callerFrame(e).trim()).join('\n'),
    restore: () => { Object.assign(globalThis, real); Error.stackTraceLimit = realStackLimit },
  }
}
