// Keyed leading+trailing coalescer: the first poke per key fires immediately; further
// pokes inside the window collapse into one trailing fire.
export function makeKeyedCoalescer(fire, { intervalMs = 250, keyOf = (x) => String(x), schedule = setTimeout, clear = clearTimeout } = {}) {
  const open = new Map()
  return {
    poke(...args) {
      const key = keyOf(...args)
      const existing = open.get(key)
      if (existing) { existing.pending = true; return }
      fire(...args)
      const state = { pending: false, timer: null }
      state.timer = schedule(() => {
        open.delete(key)
        if (state.pending) fire(...args)
      }, intervalMs)
      // An injected schedule may decline — the owned timer sets return nothing once their owner has
      // gone. Without a timer nothing would ever close the window, and every later poke for this
      // key would be swallowed as "collapsed into a trailing fire" that can never happen. No
      // window, no coalescing: each poke fires on its own, which is the safe degradation.
      if (!state.timer) return
      state.timer.unref?.()
      open.set(key, state)
    },
    flush(...args) {
      const key = keyOf(...args)
      const existing = open.get(key)
      if (existing) { clear(existing.timer); open.delete(key) }
      fire(...args)
    },
    reset() {
      for (const state of open.values()) clear(state.timer)
      open.clear()
    },
  }
}
