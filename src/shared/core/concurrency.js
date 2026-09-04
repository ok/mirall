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
