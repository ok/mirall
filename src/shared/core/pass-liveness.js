// Per-key progress bookkeeping for supervised work: one pass at a time per key, a heartbeat the
// pass bumps as it advances, and a verdict from the shared stall rule. The rule lived in
// stall-verdict.js already; the bookkeeping around it was hand-rolled twice (the mirror loop, the
// derived-view fold) and missing entirely on the owner side, where a wedged diff reads as healthy.
//
// Progress, not elapsed time: a legitimate pass over thousands of files is genuinely slow, so only
// a pass that is in flight AND not advancing is stalled.
import { stallVerdict } from './stall-verdict.js'

export function createPassLiveness ({ now = Date.now } = {}) {
  const byKey = new Map()

  return {
    // Re-entrant on purpose: at most one pass per key is ever in flight, so a restart re-stamps
    // rather than stacking.
    started (key) {
      const at = now()
      const entry = byKey.get(key)
      if (entry) { entry.startedAt = at; entry.progressAt = at } else {
        byKey.set(key, { startedAt: at, progressAt: at, completedAt: 0 })
      }
    },
    // A no-op for a key with no pass in flight, so a late callback from an abandoned pass cannot
    // resurrect a heartbeat.
    progress (key) {
      const entry = byKey.get(key)
      if (entry?.startedAt) entry.progressAt = now()
    },
    ended (key) {
      const entry = byKey.get(key)
      if (!entry) return
      entry.startedAt = 0
      entry.progressAt = 0
      entry.completedAt = now()
    },
    verdict (key, { now: at = now(), windowMs }) {
      return stallVerdict(byKey.get(key), { now: at, windowMs })
    },
    // Every key whose pass is in flight and not advancing, for a subsystem that reports on the
    // set rather than probing one key it already knows about.
    stalled ({ now: at = now(), windowMs } = {}) {
      const out = []
      for (const [key, entry] of byKey) {
        const verdict = stallVerdict(entry, { now: at, windowMs })
        if (!verdict.ok) out.push({ key, ...verdict })
      }
      return out
    },
    forget (key) { byKey.delete(key) },
    clear () { byKey.clear() },
    // A copy: nothing outside may mutate the heartbeat.
    peek (key) { const e = byKey.get(key); return e ? { ...e } : null },
  }
}
