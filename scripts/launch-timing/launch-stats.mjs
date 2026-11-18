// The numbers a launch comparison is decided on, kept pure so the rule is unit-tested apart from
// the launching. A series is the milliseconds from process start to one mark, one value per launch.
//
// Spread is the interquartile range, quantiles by linear interpolation between order statistics
// (the common "type 7" definition). Not max − min: with ten launches the range is set by the one
// run that met a cold disk cache, so a gate built on it would almost never block.
//
// The gate: the candidate's median may exceed the baseline's by at most the larger of twice the
// spread and 5% of the baseline median. The spread used is the larger of the two series' IQRs,
// because a difference smaller than the noisier series' spread cannot be told from that noise.

export const MARKS = Object.freeze(['backendReady', 'spacesShown'])

const RELATIVE_FLOOR = 0.05
const SPREAD_FACTOR = 2
// Below this a quartile is an interpolation between two or three values and says little.
export const MIN_RUNS = 5

/** @param {number[]} sorted @param {number} q */
function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/**
 * @param {number[]} values
 * @returns {{ n: number, median: number, q1: number, q3: number, iqr: number, min: number, max: number }}
 */
export function summarize(values) {
  if (!values.length || values.some((v) => !Number.isFinite(v))) throw new Error('a series needs finite values')
  const sorted = [...values].sort((a, b) => a - b)
  const q1 = quantile(sorted, 0.25)
  const q3 = quantile(sorted, 0.75)
  return {
    n: sorted.length,
    median: quantile(sorted, 0.5),
    q1,
    q3,
    iqr: q3 - q1,
    min: sorted[0],
    max: sorted[sorted.length - 1],
  }
}

/**
 * @param {number[]} baseline
 * @param {number[]} candidate
 * @returns {{ blocked: boolean, delta: number, allowed: number, spread: number, baseline: ReturnType<typeof summarize>, candidate: ReturnType<typeof summarize> }}
 */
export function markVerdict(baseline, candidate) {
  const base = summarize(baseline)
  const cand = summarize(candidate)
  const spread = Math.max(base.iqr, cand.iqr)
  const allowed = Math.max(SPREAD_FACTOR * spread, RELATIVE_FLOOR * base.median)
  const delta = cand.median - base.median
  return { blocked: delta > allowed, delta, allowed, spread, baseline: base, candidate: cand }
}

/**
 * Per-mark series out of a results file's runs. A run that missed a mark has no value for it.
 * @param {{ marks: Record<string, number | null> }[]} runs
 * @returns {Record<string, number[]>}
 */
export function seriesOf(runs) {
  return Object.fromEntries(MARKS.map((mark) => [mark, runs.map((r) => r.marks[mark]).filter(Number.isFinite)]))
}

/**
 * Whether two result files can be compared at all, and if so the verdict per mark. A mark either
 * file is missing values for refuses the comparison rather than judging fewer launches.
 * @param {{ platform: string, runs: { marks: Record<string, number | null> }[] }} baseline
 * @param {{ platform: string, runs: { marks: Record<string, number | null> }[] }} candidate
 */
export function compareResults(baseline, candidate) {
  if (baseline.platform !== candidate.platform) {
    return { refused: `measured on different platforms: ${baseline.platform} and ${candidate.platform}` }
  }
  const base = seriesOf(baseline.runs)
  const cand = seriesOf(candidate.runs)
  for (const mark of MARKS) {
    for (const [name, file, series] of [['baseline', baseline, base], ['candidate', candidate, cand]]) {
      if (series[mark].length !== file.runs.length) return { refused: `${name} has launches without a ${mark} mark` }
      if (series[mark].length < MIN_RUNS) return { refused: `${name} has ${series[mark].length} launches, at least ${MIN_RUNS} are needed` }
    }
  }
  const marks = Object.fromEntries(MARKS.map((mark) => [mark, markVerdict(base[mark], cand[mark])]))
  return { refused: null, blocked: MARKS.some((mark) => marks[mark].blocked), marks }
}
