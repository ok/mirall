// Per-key progress bookkeeping for supervised work: one pass at a time per key, a heartbeat the
// pass bumps as it advances, and a verdict from the shared stall rule (stall-verdict.js).
//
// Progress, not elapsed time: a legitimate pass over thousands of files is genuinely slow, so only
// a pass that is in flight AND not advancing is stalled.

export function createPassLiveness({ now = Date.now } = {}) {
  const byKey = new Map()
  // Never reused, so a token from an abandoned pass can never match the pass that replaced it.
  let seq = 0

  return {
    // Re-entrant on purpose: at most one pass per key is ever in flight, so a restart re-stamps
    // rather than stacking. Returns the token identifying THIS pass: a caller whose pass can be
    // abandoned under it hands the token back to ended(), so a zombie settling later cannot clear
    // the heartbeat of the pass that took its key.
    started(key) {
      const at = now()
      const pass = ++seq
      const entry = byKey.get(key)
      if (entry) { entry.startedAt = at; entry.progressAt = at; entry.pass = pass } else {
        byKey.set(key, { startedAt: at, progressAt: at, completedAt: 0, pass })
      }
      return pass
    },
    // A no-op for a key with no pass in flight, so a late callback from an abandoned pass cannot
    // resurrect a heartbeat. Token-guarded for the same reason ended() is, and it matters more
    // here: an abandoned pass beats REPEATEDLY — the owner diff beats once per catalog entry and
    // once per unchanged file — so an untokened beat does not merely delay one verdict, it holds
    // the replacement pass permanently healthy however stuck it is.
    progress(key, pass = 0) {
      const entry = byKey.get(key)
      if (!entry?.startedAt) return
      if (pass && entry.pass !== pass) return
      entry.progressAt = now()
    },
    ended(key, pass = 0) {
      const entry = byKey.get(key)
      if (!entry) return
      if (pass && entry.pass !== pass) return
      entry.startedAt = 0
      entry.progressAt = 0
      entry.completedAt = now()
    },
    verdict(key, { now: at = now(), windowMs }) {
      return stallVerdict(byKey.get(key), { now: at, windowMs })
    },
    // Every key whose pass is in flight, with its verdict — what a subsystem reports to the
    // supervisor. A key with no pass in flight is deliberately absent: there is nothing to stall.
    verdicts({ now: at = now(), windowMs } = {}) {
      const out = []
      for (const [key, entry] of byKey) {
        if (!entry.startedAt) continue
        out.push({ key, ...stallVerdict(entry, { now: at, windowMs }) })
      }
      return out
    },
    // Kept as its own name: the health() reports count wedged units, and filtering at each caller
    // would put the same predicate in three files.
    stalled(opts = {}) {
      return this.verdicts(opts).filter((row) => !row.ok)
    },
    forget(key) { byKey.delete(key) },
    clear() { byKey.clear() },
    // A copy: nothing outside may mutate the heartbeat.
    peek(key) { const e = byKey.get(key); return e ? { ...e } : null },
  }
}

// Progress, not elapsed time. Supervised work in the worker is a keyed pass with at most one in
// flight, so a pass that never settles holds its key permanently. But a legitimate pass over
// thousands of files, or a roster fold over hundreds of peers, is genuinely slow — an elapsed-time
// rule would recover healthy work mid-pass. Only a pass that is in flight AND not advancing is
// stalled, which is why every caller has to supply a heartbeat.
export function stallVerdict(liveness, { now, windowMs }) {
  const { startedAt = 0, progressAt = 0 } = liveness || {}
  if (!startedAt) return { ok: true, detail: null }
  // A pass that has not reported progress yet falls back to its start, rather than reading as
  // stalled from the epoch.
  const stalledForMs = now - (progressAt || startedAt)
  if (stalledForMs <= windowMs) return { ok: true, detail: null }
  return { ok: false, detail: `no progress for ${Math.round(stalledForMs / 1000)}s` }
}
