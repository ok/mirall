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
//  - `ranges` is the multi-family form of `range`, because hyperbee.watch takes ONE range and
//    a fold whose read set spans disjoint key families would otherwise have to watch the whole
//    bee. N ranges means N watchers per tracked bee, each holding a snapshot pair and diffing
//    on every append — worth it only when a spurious wake costs more than the watchers do,
//    which it does for any fold that reads over the network. Exclusive with `range`.

import { createPassLiveness } from '../core/pass-liveness.js'

// One fold at a time, so the keyed bookkeeping carries a single key.
const FOLD = 'fold'

export function createDerivedView ({ fold, onChange, range, ranges, onError, debounceMs = 0 } = {}) {
  if (typeof fold !== 'function') throw new Error('createDerivedView: fold is required')
  if (typeof onChange !== 'function') throw new Error('createDerivedView: onChange is required')
  // Silently preferring one would hide a read set that is half-declared.
  if (range !== undefined && ranges !== undefined) throw new Error('createDerivedView: pass range or ranges, not both')
  // An empty array would open no watcher on any source: the view folds once at boot and then never
  // re-derives, with no error and no log — a membership set frozen at whatever it was. `null` is
  // the same mistake in the other direction, silently taking the whole-bee fallback this option
  // exists to avoid. Both are a caller computing its key families and coming up empty.
  if (ranges !== undefined && (!Array.isArray(ranges) || ranges.length === 0)) {
    throw new Error('createDerivedView: ranges must be a non-empty array')
  }

  // [undefined] is the whole-bee watch the single-range form gives, so a caller passing neither
  // keeps exactly the previous behaviour.
  const watchRanges = ranges ?? [range]
  const watchers = new Map()   // sourceKey -> [{ watcher, loop }]
  let closed = false
  let scheduled = false        // a recompute is queued but not yet running
  let running = false          // a fold is in flight
  let again = false            // a change landed mid-fold → run exactly once more after
  let timer = null             // pending debounce timer (debounceMs > 0)
  let inFlight = null          // the running fold, so close() can wait for the reads it holds
  let gen = 0                  // bumped by abandon(); a fold from an older generation is inert
  const liveness = createPassLiveness()

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
    const mine = gen
    liveness.started(FOLD)
    try {
      const view = await fold()
      // Identity-guarded: a fold abandoned by a recovery must not publish a view the fold that
      // replaced it has already superseded, nor clear that fold's `running` flag below.
      if (!closed && mine === gen) onChange(view)
    } catch (err) {
      if (!closed && mine === gen) (onError || noop)(err)
    } finally {
      if (mine === gen) {
        running = false
        liveness.ended(FOLD)
        if (again && !closed) { again = false; recompute() }
      }
    }
  }

  // Bumped by the caller once per unit of work the fold completes. Without it the stall rule would
  // have to tolerate the worst-case fold — a roster of hundreds of unreachable peers, each read at
  // its own budget — and a window that generous is a window that never fires.
  function noteProgress () {
    liveness.progress(FOLD)
  }

  function health ({ now = Date.now(), windowMs }) {
    return liveness.verdict(FOLD, { now, windowMs })
  }

  // Abandon the fold in flight and let the next recompute start a fresh one. NOT close(): that
  // awaits `inFlight` so the peer reads it holds cannot outlive the store, which for a fold that is
  // not settling is a promise that never resolves. The generation bump is what makes the abandoned
  // fold inert rather than merely unawaited.
  function abandon () {
    gen += 1
    running = false
    scheduled = false
    again = false
    if (timer) { clearTimeout(timer); timer = null }
    inFlight = null
    liveness.ended(FOLD)
  }

  // Start watching a source bee (idempotent per key). Each change within `range` —
  // local or replicated — schedules a coalesced recompute. Safe to call as roster
  // members are discovered; corestore dedups the underlying cores.
  function track (key, bee) {
    if (closed || watchers.has(key)) return
    // One entry per source key holding ALL its watchers, so close() and tracking() stay keyed on
    // the source and cannot half-release a bee.
    watchers.set(key, watchRanges.map((r) => {
      const watcher = bee.watch(r)
      const loop = (async () => {
        try { for await (const _ of watcher) recompute() } catch { /* watcher closed */ }
      })()
      return { watcher, loop }
    }))
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
    for (const opened of watchers.values()) {
      for (const { watcher } of opened) {
        try { await watcher.close() } catch { /* already gone */ }
      }
    }
    watchers.clear()
  }

  return { track, tracking, size, recompute, close, abandon, noteProgress, health }
}

function noop () {}
