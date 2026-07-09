// Size-adaptive, self-correcting ETA estimator shared by every progress source via
// progress-ticker.js. Fed cumulative (now, bytes) samples; blends a since-start average
// with a recent EWMA rate (so a long job self-corrects as throughput drifts) and damps the
// emitted ETA (so it doesn't thrash with per-tick noise). eta is null during a short warmup.

const GiB = 1024 * 1024 * 1024

// Small files favour responsiveness (short windows, light damping); terabyte files favour
// stability (long windows, heavy overall-average weight). Unknown/non-positive total → small.
export function etaProfileFor (total) {
  if (!(total >= 1 * GiB)) return { recentHalfLifeMs: 2000, overallWeight: 0.30, dampHalfLifeMs: 1500, warmupMs: 1000 }
  if (total < 50 * GiB) return { recentHalfLifeMs: 8000, overallWeight: 0.60, dampHalfLifeMs: 4000, warmupMs: 2500 }
  return { recentHalfLifeMs: 20000, overallWeight: 0.85, dampHalfLifeMs: 8000, warmupMs: 5000 }
}

function ewmaAlpha (dtMs, halfLifeMs) {
  if (dtMs <= 0) return 0
  if (halfLifeMs <= 0) return 1
  return 1 - Math.pow(2, -dtMs / halfLifeMs)
}

export class EtaEstimator {
  constructor (total) {
    this._total = total
    this._p = etaProfileFor(total)
    this._startT = null
    this._startBytes = 0
    this._lastT = null
    this._lastBytes = 0
    this._recentRate = null
    this._eta = null
  }

  update (t, bytes) {
    const total = this._total
    if (this._startT === null) {
      this._startT = t
      this._startBytes = bytes
      this._lastT = t
      this._lastBytes = bytes
      return { rate: null, eta: bytes >= total ? 0 : null }
    }

    const dt = t - this._lastT
    if (dt > 0) {
      const inst = Math.max(0, (bytes - this._lastBytes) / (dt / 1000))
      const a = ewmaAlpha(dt, this._p.recentHalfLifeMs)
      this._recentRate = this._recentRate === null ? inst : this._recentRate + a * (inst - this._recentRate)
      this._lastT = t
      this._lastBytes = bytes
    }

    const remaining = Math.max(0, total - bytes)
    if (remaining === 0) {
      this._eta = 0
      return { rate: Math.max(0, this._recentRate ?? 0), eta: 0 }
    }

    const elapsed = t - this._startT
    const overallRate = elapsed > 0 ? (bytes - this._startBytes) / (elapsed / 1000) : null

    // Warmup, or a degenerate tick (clock stepped back so elapsed<=0, or no rate sample yet):
    // hold the last estimate — null while still warming, the last good value once warm — rather
    // than flicking the UI back to "estimating".
    if (elapsed < this._p.warmupMs || overallRate === null || this._recentRate === null) {
      return { rate: Math.max(0, this._recentRate ?? overallRate ?? 0), eta: this._eta }
    }

    const w = this._p.overallWeight
    const blended = w * overallRate + (1 - w) * this._recentRate
    if (!(blended > 0)) return { rate: Math.max(0, blended), eta: this._eta }
    const rawEta = remaining / blended
    if (!Number.isFinite(rawEta)) return { rate: blended, eta: this._eta }
    const a = ewmaAlpha(dt > 0 ? dt : 0, this._p.dampHalfLifeMs)
    this._eta = this._eta === null ? rawEta : this._eta + a * (rawEta - this._eta)
    return { rate: blended, eta: this._eta }
  }
}
