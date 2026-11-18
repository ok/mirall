// The geometry of the transfer speed chart: download drawn upward and upload downward from one zero
// line, both on one scale, so a small upload stays readable under a large download and the two
// never cross. Pure; the card draws what this returns.
/** @import { TransferRateSample } from '../../shared/contract/responses.js' */

// Decimal units, as every rate and size in the app is printed.
const UNIT = 1000
const STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]
// The scale never shrinks below this, so an idle chart reads as a flat line on a real axis.
const FLOOR = UNIT * UNIT

// The next round rate at or above `value`, in the units the labels are printed in.
/** @param {number} value bytes per second @returns {number} */
export function roundRateUp(value) {
  if (!(value > FLOOR)) return FLOOR
  const unit = UNIT ** Math.floor(Math.log(value) / Math.log(UNIT))
  const step = STEPS.find((s) => s * unit >= value) ?? UNIT
  return step * unit
}

/**
 * @typedef {{ width: number, height: number, left: number, right: number, top: number, bottom: number }} ChartBox
 * @typedef {{ y: number, rate: number }} ChartTick
 * @typedef {{ zeroY: number, downLine: string, downArea: string, upLine: string, upArea: string, ticks: ChartTick[], xs: number[] }} SpeedChart
 */

// How much rate each band holds. A direction with traffic gets a round scale of its own; one with
// none gets a quarter of the other, and neither is ever thinner than that quarter, so both bands
// stay readable on the one scale they share.
/** @param {readonly TransferRateSample[]} samples */
function bandHeights(samples) {
  const downPeak = Math.max(0, ...samples.map((s) => s.down))
  const upPeak = Math.max(0, ...samples.map((s) => s.up))
  if (downPeak === 0 && upPeak > 0) {
    const upMax = roundRateUp(upPeak)
    return { downMax: upMax / 4, upMax }
  }
  const downMax = roundRateUp(downPeak)
  return { downMax, upMax: Math.max(upPeak > 0 ? roundRateUp(upPeak) : 0, downMax / 4) }
}

/**
 * @param {readonly TransferRateSample[]} samples oldest first
 * @param {{ start: number, end: number }} span the time the chart's width covers
 * @param {ChartBox} box
 * @returns {SpeedChart}
 */
export function speedChart(samples, span, box) {
  const innerW = box.width - box.left - box.right
  const innerH = box.height - box.top - box.bottom
  const { downMax, upMax } = bandHeights(samples)
  const perRate = innerH / (downMax + upMax)
  const zeroY = box.top + downMax * perRate
  const duration = Math.max(1, span.end - span.start)
  const xs = samples.map((s) => box.left + (Math.min(Math.max(s.t, span.start), span.end) - span.start) / duration * innerW)
  const line = (/** @type {(s: TransferRateSample) => number} */ yOf) =>
    samples.map((s, i) => `${i ? 'L' : 'M'}${xs[i].toFixed(1)} ${yOf(s).toFixed(1)}`).join(' ')
  const area = (/** @type {string} */ path) =>
    (samples.length ? `${path} L${xs[xs.length - 1].toFixed(1)} ${zeroY.toFixed(1)} L${xs[0].toFixed(1)} ${zeroY.toFixed(1)} Z` : '')
  const downLine = line((s) => zeroY - Math.min(s.down, downMax) * perRate)
  const upLine = line((s) => zeroY + Math.min(s.up, upMax) * perRate)
  return {
    zeroY,
    downLine,
    downArea: area(downLine),
    upLine,
    upArea: area(upLine),
    ticks: [
      { y: box.top, rate: downMax },
      { y: zeroY - (downMax / 2) * perRate, rate: downMax / 2 },
      { y: zeroY, rate: 0 },
      { y: zeroY + upMax * perRate, rate: upMax },
    ],
    xs,
  }
}

// The sample a pointer at `x` reads: the nearest one, or -1 with nothing drawn.
/** @param {readonly number[]} xs @param {number} x @returns {number} */
export function nearestSample(xs, x) {
  let best = -1
  for (let i = 0; i < xs.length; i++) if (best < 0 || Math.abs(xs[i] - x) < Math.abs(xs[best] - x)) best = i
  return best
}
