import test from 'brittle'
import { EtaEstimator, etaProfileFor } from '../../src/shared/transfer/eta-estimator.js'

const MB = 1024 * 1024
const GiB = 1024 * 1024 * 1024

function mean (xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}
function stdev (xs) {
  const m = mean(xs)
  return Math.sqrt(mean(xs.map((x) => (x - m) * (x - m))))
}

test('etaProfileFor selects a tier by total size', (t) => {
  t.is(etaProfileFor(0).warmupMs, 1000, 'unknown size → small profile')
  t.is(etaProfileFor(500 * MB).warmupMs, 1000, '<1 GiB → small')
  t.is(etaProfileFor(10 * GiB).warmupMs, 2500, '1–50 GiB → medium')
  t.is(etaProfileFor(10 * GiB).overallWeight, 0.6)
  t.is(etaProfileFor(100 * GiB).warmupMs, 5000, '>50 GiB → large')
  t.is(etaProfileFor(100 * GiB).overallWeight, 0.85)
})

test('eta is null during warmup, then resolves', (t) => {
  const total = 500 * MB
  const est = new EtaEstimator(total)
  t.is(est.update(0, 0).eta, null, 'anchor → estimating')
  t.is(est.update(500, 50 * MB).eta, null, 'before warmupMs → estimating')
  const warm = est.update(1500, 150 * MB)
  t.ok(warm.eta != null && warm.eta > 0, 'after warmupMs → a positive estimate')
})

test('steady stream → eta ≈ remaining/rate and non-increasing', (t) => {
  const total = 500 * MB
  const rate = 5 * MB // per second → ~100s transfer, so the damping lag is a small fraction
  const est = new EtaEstimator(total)
  let bytes = 0
  const etas = []
  for (let ms = 0; bytes < total; ms += 250) {
    bytes = Math.min(total, (rate * ms) / 1000)
    const { eta } = est.update(ms, bytes)
    if (eta != null && bytes < total) etas.push({ ms, bytes, eta })
  }
  t.ok(etas.length > 5, 'collected warm samples')
  let prev = Infinity
  for (const s of etas) {
    t.ok(s.eta <= prev + 1e-6, 'eta is monotonically non-increasing under a steady rate')
    prev = s.eta
  }
  const mid = etas[Math.floor(etas.length / 2)]
  const trueRemain = (total - mid.bytes) / rate
  t.ok(Math.abs(mid.eta - trueRemain) / trueRemain < 0.25, `mid eta within 25% of truth (${mid.eta.toFixed(1)} vs ${trueRemain.toFixed(1)})`)
})

test('self-corrects upward when throughput drops (no "stuck low")', (t) => {
  const total = 100 * GiB
  const est = new EtaEstimator(total)
  const fastTick = 1 * GiB // 4 GiB/s for the first half
  const slowTick = 0.0625 * GiB // 0.25 GiB/s for the second half
  let bytes = 0
  let ms = 0
  let etaAt50 = null
  let etaAt75 = null
  let etaFinal = null
  while (bytes < total) {
    bytes = Math.min(total, bytes + (bytes < 50 * GiB ? fastTick : slowTick))
    ms += 250
    const { eta } = est.update(ms, bytes)
    if (eta == null) continue
    if (etaAt50 === null && bytes >= 50 * GiB) etaAt50 = eta
    if (etaAt75 === null && bytes >= 75 * GiB) etaAt75 = eta
    if (bytes < total) etaFinal = eta
  }
  t.ok(etaAt50 != null && etaAt75 != null, 'captured both checkpoints')
  t.ok(etaAt75 > etaAt50 * 1.5, `eta rose as throughput sagged (${etaAt50.toFixed(0)}s → ${etaAt75.toFixed(0)}s)`)
  t.ok(etaFinal < etaAt75, 'eta falls back toward completion')
  t.ok(Number.isFinite(etaFinal), 'never NaN/Infinity')
})

test('damps jitter far below a naive remaining/instant-rate estimate', (t) => {
  const total = 10 * GiB
  const est = new EtaEstimator(total)
  let bytes = 0
  let prevBytes = 0
  let prevMs = 0
  const estEtas = []
  const naiveEtas = []
  for (let i = 0; i < 200; i++) {
    const delta = (i % 2 === 0 ? 30 : 10) * MB // alternating, avg 80 MB/s
    bytes += delta
    const ms = (i + 1) * 250
    const { eta } = est.update(ms, bytes)
    const instRate = (bytes - prevBytes) / ((ms - prevMs) / 1000)
    const naive = (total - bytes) / instRate
    prevBytes = bytes
    prevMs = ms
    if (ms < 6000) continue // skip warmup
    if (eta != null) estEtas.push(eta)
    naiveEtas.push(naive)
  }
  t.ok(estEtas.length > 20, 'collected warm samples')
  const sEst = stdev(estEtas)
  const sNaive = stdev(naiveEtas)
  t.ok(sEst < sNaive / 3, `estimator far steadier than naive (σ ${sEst.toFixed(1)} vs ${sNaive.toFixed(1)})`)
})

test('larger files damp the estimate more than small files (size-adaptive)', (t) => {
  const smallTotal = 100 * MB
  const largeTotal = 100 * GiB
  const small = new EtaEstimator(smallTotal)
  const large = new EtaEstimator(largeTotal)
  const smallEtas = []
  const largeEtas = []
  let frac = 0
  for (let i = 0; i < 200; i++) {
    frac += (i % 2 === 0 ? 0.003 : 0.001) // same fractional trajectory in time
    const ms = (i + 1) * 250
    const se = small.update(ms, frac * smallTotal).eta
    const le = large.update(ms, frac * largeTotal).eta
    if (ms < 6000) continue // both warm
    if (se != null) smallEtas.push(se)
    if (le != null) largeEtas.push(le)
  }
  t.ok(largeEtas.length > 20 && smallEtas.length > 20, 'collected comparable samples')
  t.ok(stdev(largeEtas) < stdev(smallEtas), `large profile steadier (σ ${stdev(largeEtas).toFixed(1)} < ${stdev(smallEtas).toFixed(1)})`)
})

test('resume: anchors on the first (non-zero) sample and uses the full total', (t) => {
  const est = new EtaEstimator(1000)
  t.is(est.update(0, 400).eta, null, 'first sample at the resume baseline → estimating')
  est.update(1000, 500)
  const r = est.update(2000, 600)
  t.ok(r.eta != null && Number.isFinite(r.eta) && r.eta > 0, 'estimate is finite & positive')
  t.ok(r.rate > 0 && Number.isFinite(r.rate), 'rate reflects post-anchor progress only')
})

test('completion yields eta 0', (t) => {
  const est = new EtaEstimator(100)
  t.is(est.update(0, 0).eta, null)
  t.is(est.update(300, 100).eta, 0, 'reached total → 0')
  const done = new EtaEstimator(100)
  t.is(done.update(0, 100).eta, 0, 'arrives already complete → 0, not estimating')
})

test('a clock step backward below the start anchor holds the last eta (no flicker to null)', (t) => {
  const est = new EtaEstimator(500 * MB)
  est.update(10000, 0)
  for (let ms = 10250; ms <= 13000; ms += 250) est.update(ms, (5 * MB * (ms - 10000)) / 1000)
  const warm = est.update(13250, 5 * MB * 3.25)
  t.ok(warm.eta != null && warm.eta > 0, 'warm with a real estimate')
  const back = est.update(9000, 5 * MB * 3.3) // wall clock stepped back before the anchor
  t.is(back.eta, warm.eta, 'eta held at the last value, not reset to null')
  t.ok(back.rate >= 0, 'rate never negative')
})

test('rate stays >= 0 and finite even if bytes regress below the anchor', (t) => {
  const est = new EtaEstimator(1000)
  est.update(0, 900)
  est.update(1000, 901)
  const r = est.update(4000, 200) // bytes dropped well below the 900 anchor
  t.ok(r.rate >= 0 && Number.isFinite(r.rate), 'no negative/NaN rate leaks out')
})

test('a full stall holds without producing NaN/Infinity', (t) => {
  const est = new EtaEstimator(1000)
  est.update(0, 0)
  const r = est.update(2000, 0)
  t.is(r.eta, null, 'no progress ever → no estimate')
  t.is(r.rate, 0, 'rate is 0, not NaN')
})
