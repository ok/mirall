// Owned timer set: every handle a subsystem arms is tracked and cleared on close(), so a
// subsystem's periodic work cannot outlive it. Scheduling after close throws — a late
// continuation that still wants a timer is the bug the flag exists to surface, not something
// to swallow. Handles are opaque; clear() takes what set*() returned.

// A handle whose owning set has CLOSED is dead, and an `if (handle) return` guard on a module
// binding would read it as "armed" and latch the work off for the rest of the process. Returns the
// handle only while its owner can still clear it.
export function liveHandle(timers, handle) {
  return timers && !timers.closed ? handle : null
}

// The schedule/clear pair for an injected scheduler (makeKeyedCoalescer's, say) whose owner may not
// exist yet or may already be closed. DECLINES rather than throws: the callers run inside a
// post-close drain callback where nothing catches. Guarded on the SET, not the pointer — a _close
// that rejects never reaches its `subsystem = null`.
export function ownedScheduler(getTimers) {
  return {
    schedule: (fn, ms) => {
      const timers = getTimers()
      return timers && !timers.closed ? timers.setTimeout(fn, ms) : null
    },
    clear: (handle) => { if (handle) getTimers()?.clear(handle) },
  }
}

export function createTimers() {
  const live = new Set()
  let closed = false

  function arm(kind, fn, ms, { unref = true } = {}) {
    if (closed) throw new Error('timers: scheduling after close')
    const handle = { kind, t: null }
    handle.t = kind === 'interval'
      ? setInterval(fn, ms)
      // A timeout drops out of the set when it fires: it is spent, and holding it would grow
      // the set without bound in a subsystem that arms one per event.
      : setTimeout(() => { live.delete(handle); fn() }, ms)
    if (unref) handle.t.unref?.()
    live.add(handle)
    return handle
  }

  function disarm(handle) {
    if (handle.kind === 'interval') clearInterval(handle.t)
    else clearTimeout(handle.t)
  }

  return {
    setInterval: (fn, ms, opts) => arm('interval', fn, ms, opts),
    setTimeout: (fn, ms, opts) => arm('timeout', fn, ms, opts),
    clear(handle) { if (handle && live.delete(handle)) disarm(handle) },
    get size() { return live.size },
    get closed() { return closed },
    close() {
      closed = true
      for (const handle of live) disarm(handle)
      live.clear()
    },
  }
}
