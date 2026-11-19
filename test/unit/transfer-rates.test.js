import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { countDownloaded, countUploaded, takeCounts, resetCounts, progressCounter, createRateHistory, isRateWindow } from '../../src/shared/transfer/transfer-rates.js'
import { RATE_WINDOW } from '../../src/shared/contract/rate-window.js'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'shared', 'transfer')

test('download counts every byte, and a mirrored folder\'s share apart', (t) => {
  resetCounts()
  countDownloaded(100)
  countDownloaded(40, true)
  countUploaded(7)
  countDownloaded(0)
  countDownloaded(-5)
  t.alike(takeCounts(), { down: 140, up: 7, mirror: 40 })
  t.alike(takeCounts(), { down: 0, up: 0, mirror: 0 }, 'a take starts the next interval at zero')
})

// A resumed download reports the bytes its partial already holds before it fetches anything.
test('the first progress report is the baseline, not traffic', (t) => {
  const seen = []
  const meter = progressCounter((bytes) => seen.push(bytes))
  meter(5000)
  t.alike(seen, [], 'the resumed partial is not counted')
  meter(5600)
  meter(6000)
  meter(6000)
  meter(5900)
  meter(6100)
  t.alike(seen, [600, 400, 200], 'each increase counts once; a step back counts nothing')
})

test('the five-minute window keeps one point per second, the newest three hundred', (t) => {
  const h = createRateHistory()
  for (let s = 0; s < 320; s++) h.push(1_000_000 + s * 1000, s, s * 2)
  const pts = h.samples(RATE_WINDOW.MINUTES)
  t.is(pts.length, 300)
  t.alike(pts[0], { t: 1_000_000 + 21 * 1000, down: 20, up: 40 }, 'the oldest twenty fell out')
  t.is(pts[299].down, 319)
})

test('a coarser window stores the average rate of each of its steps', (t) => {
  const h = createRateHistory()
  const t0 = 12_000 * 1000
  for (let s = 0; s < 12; s++) h.push(t0 + s * 1000, 120, 60)
  for (let s = 12; s < 24; s++) h.push(t0 + s * 1000, s === 12 ? 1200 : 0, 0)
  t.alike(h.samples(RATE_WINDOW.HOUR), [{ t: t0 + 12_000, down: 120, up: 60 }], 'a step is stored once it is over')
  h.push(t0 + 24_000, 0, 0)
  t.alike(h.samples(RATE_WINDOW.HOUR)[1], { t: t0 + 24_000, down: 100, up: 0 }, 'a one-second burst is averaged over its step')
})

test('"today" drops the points before the given start', (t) => {
  const h = createRateHistory()
  const step = 300_000
  for (let i = 0; i < 4; i++) for (let s = 0; s < 300; s++) h.push(i * step + s * 1000, 10 * (i + 1), 0)
  h.push(4 * step, 0, 0)
  t.is(h.samples(RATE_WINDOW.TODAY).length, 4)
  t.alike(h.samples(RATE_WINDOW.TODAY, 3 * step).map((p) => p.down), [30, 40], 'a point is dated by the end of its step')
})

test('only the three declared windows are answered', (t) => {
  for (const w of ['5m', '1h', 'today']) t.ok(isRateWindow(w), w)
  for (const w of ['', '24h', 'constructor', 'toString']) t.absent(isRateWindow(w), w)
  t.alike(createRateHistory().samples('24h'), [])
})

// The rate history is the session's, by decision: nothing the meter measures reaches the disk.
test('the rate history is kept in memory only', (t) => {
  for (const file of ['transfer-rates.js', 'transfer-meter.js']) {
    const src = readFileSync(path.join(SRC, file), 'utf8')
    t.absent(/bare-fs|hyperbee|corestore|\.put\(|writeFile/.test(src), `${file} writes nothing`)
  }
})
