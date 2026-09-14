// Run `fn` over items with at most `limit` in flight; results keep input order.
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

// Counting semaphore with FIFO waiters and an express lane on top of the limit. Work the user just
// asked for takes the express lane, so a click never queues behind a backlog of automatic resumes.
// `limit` is read per acquire, so a config change takes effect without a restart; a limit of 0 (or
// less) admits everything, which is the rollback path.
export function createSemaphore({ limit, expressLanes = 1 } = {}) {
  const capOf = typeof limit === 'function' ? limit : () => limit
  const waiters = []
  let held = 0
  let expressHeld = 0

  const roomFor = (express) => {
    const cap = capOf()
    if (!(cap > 0)) return true
    if (held - expressHeld < cap) return true
    return express && expressHeld < expressLanes
  }

  function release(w) {
    if (w.released) return
    w.released = true
    held -= 1
    if (w.express) expressHeld -= 1
    pump()
  }

  function admit(w) {
    held += 1
    if (w.express) expressHeld += 1
    return () => release(w)
  }

  function pump() {
    for (let i = 0; i < waiters.length; i++) {
      if (!roomFor(waiters[i].express)) continue
      const [w] = waiters.splice(i, 1)
      i -= 1
      w.resolve(admit(w))
    }
  }

  return {
    // `owner` tags the waiter so a drain can be scoped to one producer. One gate can be shared by
    // subsystems that close at different times, and releasing all of them at the first close would
    // start work the later ones are still guarding.
    acquire({ express = false, owner = null } = {}) {
      const w = { express, owner, released: false, resolve: null }
      if (roomFor(express)) return Promise.resolve(admit(w))
      return new Promise((resolve) => {
        w.resolve = resolve
        waiters.push(w)
      })
    },
    stats: () => ({ held, queued: waiters.length, express: expressHeld }),
    // Shutdown: hand queued callers a no-op release so a parked acquire cannot hold close() past
    // the stop deadline. They resume and find their own cancelled/stopping checks. No argument
    // drains everyone; an owner drains only that producer and leaves the rest queued in order.
    drain(owner) {
      const keep = []
      while (waiters.length) {
        const w = waiters.shift()
        if (owner == null || w.owner === owner) w.resolve(() => {})
        else keep.push(w)
      }
      for (const w of keep) waiters.push(w)
    },
  }
}

// Per-key serialization: chains async functions on a per-key promise so each runs
// after the previous settles. The stored tail swallows rejections so one failure
// can't poison the chain; the returned promise still rejects so the caller sees errors.
// A key's entry is dropped once its chain drains, so the map stays bounded by the keys
// actually in flight rather than by every key the process has ever touched.
export function createKeyedLock() {
  const chains = new Map()
  function runExclusive(key, fn) {
    const prev = chains.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.then(() => {}, () => {})
    chains.set(key, tail)
    tail.then(() => { if (chains.get(key) === tail) chains.delete(key) })
    return next
  }
  runExclusive.pending = () => chains.size
  return runExclusive
}

// At most one run per key in flight, plus one queued rerun that absorbs every request arriving
// while the run executes. A queued caller settles with the rerun's outcome: a run that started
// before its request cannot have seen the change that prompted it. `merge(queued, next)` folds a
// newly arriving request into the pending one.
//
// `cancel(key)` abandons the run in flight: the pass itself is stopped through whatever abort route
// its caller owns, and this drops the key so the next request starts a fresh run instead of
// coalescing onto a promise that may never settle.
//
// EVERY caller of a run is a waiter on its entry — the one that started it as much as the ones that
// coalesced onto it — so cancel() can settle all of them; a caller held only in a local closure
// would be parked forever by the very abandon that exists to un-wedge it.
export function createCoalescingRunner({ merge = (queued) => queued, cancelledValue = undefined } = {}) {
  const state = new Map()

  const settleAll = (waiters, method, value) => { for (const w of waiters.splice(0)) w[method](value) }

  function run(key, opts, fn) {
    const entry = state.get(key)
    if (entry) {
      if (!entry.queued) entry.queued = { opts, waiters: [] }
      else entry.queued.opts = merge(entry.queued.opts, opts)
      return new Promise((resolve, reject) => entry.queued.waiters.push({ resolve, reject }))
    }
    const fresh = { waiters: [], queued: null }
    state.set(key, fresh)
    const settled = new Promise((resolve, reject) => fresh.waiters.push({ resolve, reject }))
    // Not awaited and never rejects: execute settles its callers through their own promises, so a
    // rejecting pass surfaces on the caller that asked for it and nowhere else.
    execute(key, fresh, opts, fn)
    return settled
  }

  async function execute(key, entry, opts, fn) {
    // Captured before the await: a rerun replaces entry.waiters with its own, and this run must
    // still settle the callers it started with.
    const mine = entry.waiters
    let result
    let error
    try { result = await fn(opts) } catch (err) { error = err }
    // Identity-guarded: a run abandoned by cancel() must not clear the entry that replaced it, nor
    // start the rerun that entry is holding. Identity alone is enough — every path that abandons a
    // run removes its entry from `state`, and run() only ever inserts a fresh object, so a stale
    // entry can never be the one `state` holds. Its callers were settled by cancel().
    if (state.get(key) !== entry) return
    const next = entry.queued
    entry.queued = null
    entry.waiters = next ? next.waiters : []
    if (next) execute(key, entry, next.opts, fn)
    else state.delete(key)
    if (error) settleAll(mine, 'reject', error)
    else settleAll(mine, 'resolve', result)
  }

  // Abandon the run in flight. Its callers are RESOLVED with `cancelledValue`, not rejected: they
  // asked for a pass, the pass was abandoned, and the caller that already models that — the
  // owner-side diff settles an aborted pass as { cancelled: true } — must not have to learn a new
  // error type to keep working. Both buckets settle: the callers of the run being abandoned, and
  // the ones queued behind it, which are otherwise left waiting for a rerun that will never start.
  function cancel(key) {
    const entry = state.get(key)
    if (!entry) return false
    state.delete(key)
    const waiting = [...entry.waiters, ...(entry.queued?.waiters || [])]
    entry.waiters = []
    entry.queued = null
    for (const w of waiting) w.resolve(cancelledValue)
    return true
  }

  run.isRunning = (key) => state.has(key)
  run.cancel = cancel
  return run
}
