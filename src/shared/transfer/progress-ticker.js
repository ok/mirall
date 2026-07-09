// Throttled byte-progress ticker shared by the single-file transfer path
// (transfers.js) and the folder-mirror path (foreign-folders.js), so the two
// don't drift in how they compute speed/ETA or how often they emit.
//
// Feed it chunk lengths via `push(len)`; it calls `emit({ bytes, total, speed,
// eta })` at most once per `intervalMs`. The first chunk always emits (lastEmit
// starts at 0). `speed` is the estimator's smoothed rate; `eta` is null during the
// estimator warmup, else rounded seconds (0 when complete). `now` is injectable for
// deterministic tests.
import { EtaEstimator } from './eta-estimator.js'

export function makeProgressTicker(total, emit, { intervalMs = 250, now = Date.now } = {}) {
  let transferred = 0
  let lastEmit = 0
  const est = new EtaEstimator(total)

  const ticker = {
    push(len) {
      transferred += len
      const t = now()
      if (t - lastEmit <= intervalMs) return
      const { rate, eta } = est.update(t, transferred)
      emit({
        bytes: transferred,
        total,
        speed: rate != null ? Math.round(rate) : 0,
        eta: eta == null ? null : Math.round(eta),
      })
      lastEmit = t
    },
    // For sources that report CUMULATIVE bytes (e.g. the overlay scheduler, which
    // seeds the count with resumed on-disk bytes) rather than per-chunk increments:
    // push the delta since the last report.
    pushTo(cumulative) {
      this.push(Math.max(0, cumulative - transferred))
    },
    get transferred() {
      return transferred
    },
  }
  return ticker
}
