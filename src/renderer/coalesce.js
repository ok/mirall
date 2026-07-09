// Leading+trailing coalescer for the listing refresh. The worker emits one
// files-updated per catalog append; during a large index that is a storm. The
// first event fires immediately; a burst within intervalMs collapses to one
// trailing call. Timers are injectable so the logic is deterministically testable.
//
// Same leading+trailing algorithm as makeSharesRefresh (the owner-side coalescer in
// src/shared/transfer/backends/overlay/overlay-refresh.js); kept as a separate copy because
// the renderer can't import from the worker data layer — keep the two in sync.
export function makeCoalescer(fn, { intervalMs = 750, schedule = setTimeout, clear = clearTimeout } = {}) {
  let timer = null
  let pending = false
  return {
    trigger() {
      if (timer) { pending = true; return }
      fn()
      timer = schedule(() => {
        timer = null
        if (pending) { pending = false; fn() }
      }, intervalMs)
      timer?.unref?.()
    },
    cancel() { if (timer) clear(timer); timer = null; pending = false },
  }
}
