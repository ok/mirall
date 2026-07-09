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
      state.timer?.unref?.()
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
