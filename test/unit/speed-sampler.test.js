import test from 'brittle'
import { SpeedSampler, decayedSpeed } from '../../src/renderer/speedSampler.js'

const MB = 1024 * 1024

test('returns null until at least two samples', (t) => {
  const s = new SpeedSampler()
  t.is(s.avg(0), null, 'empty')
  s.push(0, 0)
  t.is(s.avg(0), null, 'one sample')
})

test('steady stream averages to the true rate once the window fills', (t) => {
  const s = new SpeedSampler()
  for (let i = 0; i <= 12; i++) s.push(i * 250, i * MB) // 1 MB / 250 ms = 4 MB/s
  t.is(Math.round(s.avg(3000) / MB), 4)
})

test('only samples within the last 3s contribute (time-window, not count)', (t) => {
  const s = new SpeedSampler()
  s.push(0, 100 * MB) // early fast burst, long ago
  for (let i = 0; i < 13; i++) s.push(5000 + i * 250, 100 * MB + i * MB) // slow 4 MB/s stream
  const rate = s.avg(8000) / MB
  t.ok(rate > 3.5 && rate < 4.5, `current rate ≈4 MB/s, old burst excluded (got ${rate.toFixed(2)})`)
})

test('a single fast tick is diluted into the windowed mean, not surfaced as a spike', (t) => {
  const s = new SpeedSampler()
  s.push(0, 0)
  s.push(250, 1 * MB)  // 4 MB/s
  s.push(500, 21 * MB) // 80 MB/s spike
  s.push(750, 22 * MB) // 4 MB/s
  const rate = s.avg(750) / MB
  t.ok(rate > 25 && rate < 35, `windowed mean, far below the 80 MB/s spike (got ${rate.toFixed(1)})`)
})

test('a stall decays the rate toward zero against the clock', (t) => {
  const s = new SpeedSampler()
  for (let i = 0; i <= 12; i++) s.push(i * 250, i * MB) // 4 MB/s up to t=3000
  const at3 = s.avg(3000)
  const at35 = s.avg(3500)
  const at4 = s.avg(4000)
  t.ok(at35 < at3, 'decays at +0.5s')
  t.ok(at4 < at35, 'decays further at +1s')
  t.is(s.avg(7000), null, 'window empty after a long stall → null')
})

test('resume after a long gap re-establishes a fresh rate, gap not averaged in', (t) => {
  const s = new SpeedSampler()
  s.push(0, 0)
  s.push(250, 1 * MB)
  s.push(10000, 1 * MB) // 10s of silence, then resume
  t.is(s.avg(10000), null, 'pre-gap samples pruned → one fresh sample → null')
  s.push(10250, 5 * MB) // 4 MB / 250 ms = 16 MB/s
  t.is(Math.round(s.avg(10250) / MB), 16)
})

test('defensive: non-increasing bytes and non-advancing clock yield null', (t) => {
  const s = new SpeedSampler()
  s.push(0, 10 * MB)
  s.push(250, 5 * MB)
  t.is(s.avg(250), null, 'db < 0 → null')
  const s2 = new SpeedSampler()
  s2.push(1000, 0)
  s2.push(1000, 1 * MB)
  t.is(s2.avg(900), null, 'dt <= 0 → null')
})

test('reset clears the window', (t) => {
  const s = new SpeedSampler()
  s.push(0, 0)
  s.push(250, 1 * MB)
  t.not(s.avg(250), null)
  s.reset()
  t.is(s.avg(250), null)
})

test('idleMs reports time since the last sample (Infinity when empty)', (t) => {
  const s = new SpeedSampler()
  t.is(s.idleMs(1000), Infinity, 'no samples')
  s.push(1000, 0)
  t.is(s.idleMs(1500), 500)
})

test('decayedSpeed returns null (leave value alone) while data is fresh', (t) => {
  const s = new SpeedSampler()
  s.push(1000, 0)
  s.push(1250, 1 * MB)
  t.is(decayedSpeed(s, 1550, 4 * MB), null, 'last sample 300ms ago → fresh → no heartbeat write')
})

test('decayedSpeed decays to a positive rate, then to 0, once data stops', (t) => {
  const s = new SpeedSampler()
  for (let i = 0; i <= 12; i++) s.push(i * 250, i * MB) // 4 MB/s up to t=3000
  const decaying = decayedSpeed(s, 4500, 4 * MB)
  t.ok(decaying !== null && decaying > 0 && decaying < 4 * MB, `decaying positive rate (got ${decaying})`)
  t.is(decayedSpeed(s, 9000, 1 * MB), 0, 'window emptied, had a value → 0')
})

test('decayedSpeed returns null until a row has ever had a value (no 0 flash)', (t) => {
  t.is(decayedSpeed(undefined, 1000, undefined), null, 'just clicked: no sampler, no prior value')
  const s = new SpeedSampler()
  s.push(1000, 0)
  t.is(decayedSpeed(s, 5000, undefined), null, 'one stale sample, never valued → null')
})
