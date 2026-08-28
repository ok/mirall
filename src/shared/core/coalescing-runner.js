// At most one run per key in flight, plus one queued rerun that absorbs every request arriving
// while the run executes. A queued caller settles with the rerun's outcome: a run that started
// before its request cannot have seen the change that prompted it. `merge(queued, next)` folds a
// newly arriving request into the pending one.
export function createCoalescingRunner({ merge = (queued) => queued } = {}) {
  const state = new Map()

  function run(key, opts, fn) {
    const entry = state.get(key)
    if (!entry) {
      const fresh = { queued: null }
      state.set(key, fresh)
      return execute(key, fresh, opts, fn)
    }
    if (!entry.queued) entry.queued = { opts, waiters: [] }
    else entry.queued.opts = merge(entry.queued.opts, opts)
    return new Promise((resolve, reject) => entry.queued.waiters.push({ resolve, reject }))
  }

  async function execute(key, entry, opts, fn) {
    let result
    let error
    try { result = await fn(opts) } catch (err) { error = err }
    const next = entry.queued
    entry.queued = null
    if (next) {
      execute(key, entry, next.opts, fn).then(
        (r) => { for (const w of next.waiters) w.resolve(r) },
        (e) => { for (const w of next.waiters) w.reject(e) },
      )
    } else {
      state.delete(key)
    }
    if (error) throw error
    return result
  }

  run.isRunning = (key) => state.has(key)
  return run
}
