// Rolling download-speed average over a time window, evaluated against the current
// clock so a stall decays toward zero instead of freezing on a stale value.

const WINDOW_MS = 3000
const IDLE_GRACE_MS = 1100

export class SpeedSampler {
  #samples = []

  push (t, bytes) {
    this.#samples.push({ t, bytes })
  }

  avg (now) {
    this.#prune(now)
    if (this.#samples.length < 2) return null
    const oldest = this.#samples[0]
    const latest = this.#samples[this.#samples.length - 1]
    const dt = (Math.max(now, latest.t) - oldest.t) / 1000
    const db = latest.bytes - oldest.bytes
    if (dt <= 0 || db < 0) return null
    return db / dt
  }

  idleMs (now) {
    const n = this.#samples.length
    return n === 0 ? Infinity : now - this.#samples[n - 1].t
  }

  #prune (ref) {
    const cutoff = ref - WINDOW_MS
    this.#samples = this.#samples.filter(s => s.t >= cutoff)
  }

  reset () {
    this.#samples = []
  }
}

// Heartbeat-side speed for a row with no fresh progress event. Returns null for "leave
// the displayed value alone" — when data is still fresh (the event path owns it) or the
// row has never had a value (so a just-started download doesn't flash 0) — a positive
// rate while a stall decays, or 0 once the window empties.
export function decayedSpeed (sampler, now, prev) {
  if (sampler && sampler.idleMs(now) < IDLE_GRACE_MS) return null
  const rate = sampler ? sampler.avg(now) : null
  if (rate != null) return rate
  return prev != null ? 0 : null
}
