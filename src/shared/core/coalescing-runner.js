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
// coalesced onto it — because that is what lets an abandoned run settle all of them. Callers held
// only in a local closure (the shape this replaced) were unreachable from cancel(): abandoning a
// wedged pass left them parked forever, which is the opposite of what abandoning it is for.
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
