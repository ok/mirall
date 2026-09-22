// The per-mount loop the mirror engine runs on, with no knowledge of catalogs, hashes or mounts:
// an interval per key, at most one pass in flight, a dirty flag so a request arriving mid-pass
// costs exactly one follow-up, a cancellation generation a long pass checks between files, and the
// liveness heartbeat the supervisor reads.
import { createPassLiveness } from '../core/pass-liveness.js'

export function createMirrorLoops({ intervalMs, runPass, onStop = () => {}, onError = () => {} }) {
  const loops = new Map()      // key -> { timer, spaceId, shareId }
  const inFlight = new Map()   // key -> Promise
  const dirty = new Set()
  const pending = new Map()    // key -> debounce timer
  const gen = new Map()
  const liveness = createPassLiveness()

  const generationOf = (key) => gen.get(key) || 0
  const stopped = (key, at) => generationOf(key) !== at

  // Identity-guarded: a stale pass settling after a restart replaced the entry must not delete the
  // LIVE one, which would un-serialise two passes over the same mount.
  function settle(key, p, ctx) {
    if (inFlight.get(key) !== p) return
    inFlight.delete(key)
    liveness.ended(key)
    if (dirty.delete(key)) tick(key, ctx).catch(onError)
  }

  function track(key, p, ctx) {
    const tracked = p.finally(() => settle(key, tracked, ctx))
    inFlight.set(key, tracked)
    liveness.started(key)
    return tracked
  }

  // Serialised per key: the poll and any event-driven trigger must never overlap, or two passes
  // act on stale snapshots and each re-does what the other just undid. A request arriving while a
  // pass runs sets the dirty flag so exactly one follow-up runs after it.
  function tick(key, ctx) {
    const running = inFlight.get(key)
    if (running) {
      dirty.add(key)
      return running
    }
    // Invoked synchronously, like the interval callback it replaces: a caller that inspects the
    // pass right after asking for it must see it already started.
    let p
    try { p = Promise.resolve(runPass(ctx)) } catch (err) { p = Promise.reject(err) }
    return track(key, p, ctx)
  }

  // Register a pass run outside `tick` (the initial scan) so the bulk stop has something to await.
  // It honours the generation itself; the stop can only wait for what it sees. A pass already in
  // flight is never displaced: the adopted one starts when it settles, so two passes never walk one
  // mount at once.
  //
  // It takes the ctx for the same reason `tick` does: a request arriving while the boot scan runs
  // sets the dirty flag, and without a ctx to run it with, that follow-up was consumed and dropped
  // — so a resume landing during the initial materialize scan did nothing at all.
  function adopt(key, run, ctx) {
    const running = inFlight.get(key)
    let p
    if (running) p = running.catch(() => {}).then(run)
    else {
      try { p = Promise.resolve(run()) } catch (err) { p = Promise.reject(err) }
    }
    return track(key, p, ctx)
  }

  function start(key, ctx) {
    if (loops.has(key)) return
    const timer = setInterval(() => { tick(key, ctx).catch(onError) }, intervalMs())
    timer.unref?.()
    loops.set(key, { timer, spaceId: ctx.spaceId, shareId: ctx.shareId })
  }

  function debounce(key, ctx, ms) {
    if (pending.has(key)) return
    const timer = setTimeout(() => {
      pending.delete(key)
      tick(key, ctx).catch(onError)
    }, ms)
    timer.unref?.()
    pending.set(key, timer)
  }

  // Cancel every pass started so far without disarming the cadence: they bail at their next
  // checkpoint and decline their writes, while a later pass runs at the new generation. A verb that
  // takes the record away from its passes calls this before its own write, so a pass can never
  // write after it, and a write that fails still leaves a running loop.
  function invalidate(key) {
    gen.set(key, generationOf(key) + 1)
    return generationOf(key)
  }

  // Invalidate the pass in flight (it bails at its next checkpoint) and disarm the cadence.
  // Deliberately does NOT clear inFlight: a pause must still be able to await the tail, and a
  // restart is what clears it.
  function stop(key, opts = {}) {
    invalidate(key)
    onStop(key, opts)
    dirty.delete(key)
    const handle = loops.get(key)
    if (handle) {
      clearInterval(handle.timer)
      loops.delete(key)
    }
    const queued = pending.get(key)
    if (queued) {
      clearTimeout(queued)
      pending.delete(key)
    }
  }

  // The un-wedge: clearing inFlight is the part `stop` does not do, and without it a fresh
  // interval coalesces straight back onto the dead promise — and because a coalesced call never
  // marks a pass started, the liveness probe would report the mirror healthy.
  function restart(key, ctx) {
    stop(key)
    inFlight.delete(key)
    dirty.delete(key)
    liveness.forget(key)
    start(key, ctx)
    return tick(key, ctx)
  }

  // Each stop bumps the loop's generation so a pass mid-iteration bails at its next checkpoint;
  // the bounded wait lets that bail land before the caller closes the resources the pass reads.
  async function stopAll({ settleMs = 5000 } = {}) {
    for (const key of [...loops.keys()]) stop(key)
    const running = [...inFlight.values()]
    if (running.length === 0) return
    await Promise.race([
      Promise.allSettled(running),
      new Promise((resolve) => { setTimeout(resolve, settleMs).unref?.() }),
    ])
  }

  return {
    start,
    invalidate,
    stop,
    stopAll,
    restart,
    tick,
    adopt,
    debounce,
    generationOf,
    stopped,
    live: (key) => loops.has(key),
    // Only mounts with a live loop. One without is paused, unmounted or gone, none of which a
    // health report or a recovery can or should address.
    entries: () => [...loops.entries()].map(([key, l]) => ({ key, spaceId: l.spaceId, shareId: l.shareId })),
    liveness: (key) => liveness.peek(key),
    forgetLiveness: (key) => liveness.forget(key),
    noteProgress: (key) => liveness.progress(key),
    dropInFlight: (key) => inFlight.delete(key),
    // Resolves once no pass is in flight for the key, follow-ups included: a pass settling with the
    // dirty flag set has already tracked its follow-up by the time its own promise resolves.
    idle: async (key) => {
      let running
      while ((running = inFlight.get(key))) await running.catch(() => {})
    },
  }
}
