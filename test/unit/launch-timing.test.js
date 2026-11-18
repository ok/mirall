import test from 'brittle'
import { summarize, markVerdict, compareResults, MIN_RUNS } from '../../scripts/launch-timing/launch-stats.mjs'
import { descendantsOf, parseProcessTable } from '../../scripts/launch-timing/app-process.mjs'
import { devtoolsUrlIn } from '../../scripts/launch-timing/marks.mjs'

const TEN = [1000, 1010, 1020, 1030, 1040, 1050, 1060, 1070, 1080, 1090]
const shifted = (series, by) => series.map((v) => v + by)
const results = (platform, backendReady, spacesShown = backendReady) => ({
  platform,
  runs: backendReady.map((v, i) => ({ marks: { backendReady: v, spacesShown: spacesShown[i] } })),
})

test('a series is summarised by its median and interquartile range', (t) => {
  const s = summarize([1090, 1000, 1080, 1010, 1070, 1020, 1060, 1030, 1050, 1040])
  t.is(s.n, 10)
  t.is(s.median, 1045, 'the median of an even count is the mean of the middle two')
  t.is(s.q1, 1022.5, 'quartiles interpolate between order statistics')
  t.is(s.q3, 1067.5)
  t.is(s.iqr, 45)
  t.is(s.min, 1000)
  t.is(s.max, 1090)
})

test('one outlying launch moves the range but not the spread', (t) => {
  const cold = [...TEN.slice(0, 9), 4000]
  t.is(summarize(cold).iqr, summarize(TEN).iqr, 'the IQR ignores a single cold-cache run')
  t.is(summarize(cold).median, summarize(TEN).median)
})

test('a series with no values or a non-number is refused', (t) => {
  t.exception(() => summarize([]))
  t.exception(() => summarize([1, NaN]))
})

test('the gate allows 5% of the baseline median when the runs are tight', (t) => {
  const tight = Array(10).fill(1000)
  t.absent(markVerdict(tight, Array(10).fill(1050)).blocked, 'exactly 5% slower passes')
  const v = markVerdict(tight, Array(10).fill(1051))
  t.ok(v.blocked, 'more than 5% slower blocks')
  t.is(v.allowed, 50)
  t.is(v.delta, 51)
})

test('the gate allows twice the spread when that is larger than 5%', (t) => {
  const noisy = [800, 900, 950, 1000, 1000, 1000, 1000, 1050, 1100, 1200]
  const spread = summarize(noisy).iqr
  t.ok(2 * spread > 50, 'the fixture is noisier than 5% of its median')
  t.absent(markVerdict(noisy, shifted(noisy, 2 * spread)).blocked, 'a shift of exactly twice the spread passes')
  t.ok(markVerdict(noisy, shifted(noisy, 2 * spread + 1)).blocked, 'one millisecond more blocks')
})

test('the spread is the larger of the two series', (t) => {
  const tight = Array(10).fill(1000)
  const noisy = [800, 900, 950, 1000, 1000, 1000, 1000, 1050, 1100, 1200]
  t.is(markVerdict(tight, noisy).spread, summarize(noisy).iqr, 'a noisy candidate widens the allowance')
  t.is(markVerdict(noisy, tight).spread, summarize(noisy).iqr, 'and so does a noisy baseline')
})

test('a faster candidate never blocks', (t) => {
  t.absent(markVerdict(TEN, shifted(TEN, -500)).blocked)
})

test('the cut is blocked when either mark is over the gate', (t) => {
  const backendSlow = compareResults(results('darwin', TEN, TEN), results('darwin', shifted(TEN, 200), TEN))
  t.is(backendSlow.refused, null)
  t.ok(backendSlow.blocked)
  t.ok(backendSlow.marks.backendReady.blocked)
  t.absent(backendSlow.marks.spacesShown.blocked)

  const spacesSlow = compareResults(results('darwin', TEN, TEN), results('darwin', TEN, shifted(TEN, 200)))
  t.ok(spacesSlow.blocked, 'the spaces mark alone blocks too')

  t.absent(compareResults(results('darwin', TEN), results('darwin', shifted(TEN, 10))).blocked)
})

test('results that cannot be compared are refused, not judged', (t) => {
  t.ok(compareResults(results('darwin', TEN), results('win32', TEN)).refused, 'different platforms')

  const missing = results('darwin', TEN)
  missing.runs[3].marks.spacesShown = null
  t.ok(compareResults(results('darwin', TEN), missing).refused, 'a launch without a mark')

  const few = TEN.slice(0, MIN_RUNS - 1)
  t.ok(compareResults(results('darwin', few), results('darwin', few)).refused, 'too few launches')
})

test('the process tree is every pid reachable from the app', (t) => {
  const table = parseProcessTable('  1     0\n 100     1\n 101   100\n 102   100\n 103   102\n 200     1\n\r\n')
  t.alike(descendantsOf(table, 100).sort(), [100, 101, 102, 103])
  t.alike(descendantsOf(table, 999), [999], 'a root with no children is itself')
})

test('the DevTools endpoint is read from the line Chromium prints', (t) => {
  t.is(devtoolsUrlIn('DevTools listening on ws://127.0.0.1:52011/devtools/browser/0a1b-2c3d'),
    'ws://127.0.0.1:52011/devtools/browser/0a1b-2c3d')
  t.is(devtoolsUrlIn('[worker stderr] something else'), null)
})
