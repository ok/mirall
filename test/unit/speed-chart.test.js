import test from 'brittle'
import { roundRateUp, speedChart, nearestSample } from '../../src/renderer/model/speed-chart.js'

const MB = 1000 * 1000
const BOX = { width: 236, height: 150, left: 36, right: 0, top: 10, bottom: 20 }
const SPAN = { start: 0, end: 300_000 }
const at = (t, down, up) => ({ t, down, up })

test('the scale rounds up to a rate that reads well, and never below 1 MB/s', (t) => {
  t.is(roundRateUp(0), MB)
  t.is(roundRateUp(300 * 1000), MB)
  t.is(roundRateUp(1.2 * MB), 2 * MB)
  t.is(roundRateUp(12.9 * MB), 20 * MB)
  t.is(roundRateUp(20 * MB), 20 * MB)
  t.is(roundRateUp(600 * MB), 1000 * MB)
})

test('download rises above the zero line and upload hangs below it, on one scale', (t) => {
  const c = speedChart([at(0, 10 * MB, 0), at(150_000, 5 * MB, 2 * MB), at(300_000, 0, 2 * MB)], SPAN, BOX)
  const ys = (path) => path.split(/[ML]/).filter(Boolean).map((p) => Number(p.trim().split(' ')[1]))
  const down = ys(c.downLine)
  const up = ys(c.upLine)
  t.is(down[0], BOX.top, 'a download at the top of the scale touches the top')
  t.is(down[2], Number(c.zeroY.toFixed(1)), 'no download sits on the zero line')
  t.ok(up[1] > c.zeroY, 'upload is drawn below')
  // One scale: half the download range above is as tall as the same rate below.
  const perMb = (c.zeroY - BOX.top) / 10
  t.ok(Math.abs((up[1] - c.zeroY) - 2 * perMb) < 0.2, 'a megabyte is as tall below the line as above it')
  t.alike(c.ticks.map((k) => k.rate), [10 * MB, 5 * MB, 0, 2.5 * MB], 'the lower band keeps a quarter of the upper')
})

test('a direction with no traffic keeps a quarter of the other one\'s height', (t) => {
  const onlyDown = speedChart([at(0, 3 * MB, 0)], SPAN, BOX)
  t.alike(onlyDown.ticks.map((k) => k.rate), [5 * MB, 2.5 * MB, 0, 1.25 * MB])
  const onlyUp = speedChart([at(0, 0, 3 * MB)], SPAN, BOX)
  t.alike(onlyUp.ticks.map((k) => k.rate), [1.25 * MB, 0.625 * MB, 0, 5 * MB])
  const idle = speedChart([at(0, 0, 0)], SPAN, BOX)
  t.alike(idle.ticks.map((k) => k.rate), [MB, 0.5 * MB, 0, 0.25 * MB])
})

test('points sit where their time falls in the window, so a short history hugs "now"', (t) => {
  const c = speedChart([at(270_000, MB, 0), at(300_000, MB, 0)], SPAN, BOX)
  t.is(c.xs[1], BOX.width, 'the newest point is at the right edge')
  t.ok(c.xs[0] > BOX.left + 150, 'thirty seconds of history fill only the right end')
  const clamped = speedChart([at(-5000, MB, 0)], SPAN, BOX)
  t.is(clamped.xs[0], BOX.left, 'a point older than the window is held at its left edge')
})

test('an empty history draws nothing and still has an axis', (t) => {
  const c = speedChart([], SPAN, BOX)
  t.is(c.downLine, '')
  t.is(c.downArea, '')
  t.is(c.ticks.length, 4)
  t.is(nearestSample(c.xs, 100), -1)
})

test('the pointer reads the nearest point', (t) => {
  t.is(nearestSample([10, 20, 30], 24), 1)
  t.is(nearestSample([10, 20, 30], 26), 2)
  t.is(nearestSample([10, 20, 30], -50), 0)
})
