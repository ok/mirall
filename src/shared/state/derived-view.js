// Generic durable-state view primitive: watch a set of replicated
// source bees and, whenever any of them changes — locally OR via replication —
// recompute a derived view by folding all sources. Bursts collapse into a single
// recompute. The view is held in memory and emitted via onChange; it is NEVER
// persisted — it is a pure function of the replicated logs, so it can always be
// rebuilt by re-folding.
//
// Why this works without polling: hyperbee.watch(range) fires on REMOTE (replicated)
// appends too — it hangs off the underlying core's 'append' event, which fires for a
// peer's blocks once they replicate. That is the same mechanism the swarm already uses
// to react to a peer's approval/avatar writes.
//
// Caveats baked into the contract:
//  - watch() only works on a MAIN bee instance, never a sub()/checkout/snapshot — so
//    callers pass the opened bee plus a key `range`, not `bee.sub(prefix)`.
//  - `range` is optional. Omit it to watch the whole bee (coarser: fires on unrelated
//    keys too, e.g. avatar/displayName), or pass { gte, lt } to scope it. Over-firing is
//    safe — the fold is deterministic and idempotent, so an extra recompute only costs
//    a fold, never correctness.

export function createDerivedView ({ fold, onChange, range, onError, debounceMs = 0 } = {}) {
  if (typeof fold !== 'function') throw new Error('createDerivedView: fold is required')
  if (typeof onChange !== 'function') throw new Error('createDerivedView: onChange is required')

  const watchers = new Map()   // sourceKey -> { watcher, loop }
  let closed = false
  let scheduled = false        // a recompute is queued but not yet running
  let running = false          // a fold is in flight
  let again = false            // a change landed mid-fold → run exactly once more after
  let timer = null             // pending debounce timer (debounceMs > 0)
  let inFlight = null          // the running fold, so close() can wait for the reads it holds

  // Coalesce a burst of change signals into one fold and serialize folds so two changes
  // can't run overlapping folds whose results land out of order. If a change arrives while
  // a fold is in flight, run exactly one trailing fold afterwards so the view always
  // reflects the latest state without piling up redundant work. With debounceMs > 0 a
  // single trailing timer absorbs a replication burst (which arrives across many ticks, not
  // one microtask) into one fold; debounceMs = 0 keeps the microtask-coalescing path.
  function recompute () {
    if (closed) return
    if (running) { again = true; return }
    if (scheduled) return
    scheduled = true
    const start = () => { inFlight = run() }
    if (debounceMs > 0) { timer = setTimeout(start, debounceMs); timer.unref?.() }
    else queueMicrotask(start)
  }

  async function run () {
    if (closed) { scheduled = false; return }
    scheduled = false
    timer = null
    running = true
    try {
      const view = await fold()
      if (!closed) onChange(view)
    } catch (err) {
      if (!closed) (onError || noop)(err)
    } finally {
      running = false
      if (again && !closed) { again = false; recompute() }
    }
  }

  // Start watching a source bee (idempotent per key). Each change within `range` —
  // local or replicated — schedules a coalesced recompute. Safe to call as roster
  // members are discovered; corestore dedups the underlying cores.
  function track (key, bee) {
    if (closed || watchers.has(key)) return
    const watcher = bee.watch(range)
    const loop = (async () => {
      try { for await (const _ of watcher) recompute() } catch { /* watcher closed */ }
    })()
    watchers.set(key, { watcher, loop })
  }

  function tracking (key) { return watchers.has(key) }
  function size () { return watchers.size }

  async function close () {
    closed = true
    if (timer) { clearTimeout(timer); timer = null }
    // A fold in flight is reading peer bees, and each read holds a core session until it
    // resolves. Closing out from under it leaves those sessions open for the store to find.
    try { await inFlight } catch { /* the fold's own error path already reported */ }
    inFlight = null
    for (const { watcher } of watchers.values()) {
      try { await watcher.close() } catch { /* already gone */ }
    }
    watchers.clear()
  }

  return { track, tracking, size, recompute, close }
}

function noop () {}
