// How fast this device is transferring: the byte counters every download and every serve feeds, and
// the history of the rate kept for the transfers page. Pure, and memory only: nothing here is
// written to disk, so the history starts empty with the app.
//
// Download counts every byte fetched, a mirrored folder's included, so a busy connection never
// reads as idle; upload counts every byte served. The share fetched by mirrors is counted apart,
// which is what lets the page say where a rate with no listed transfer comes from.

import { RATE_WINDOW } from '../contract/rate-window.js'
/** @import { RateWindow } from '../contract/rate-window.js' */
/** @typedef {{ t: number, down: number, up: number }} RateSample */

// Each window holds about the same number of points, so a chart is as dense at a day as at five
// minutes: one second, twelve seconds and five minutes per point.
const RINGS = Object.freeze({
  [RATE_WINDOW.MINUTES]: { stepMs: 1000, size: 300 },
  [RATE_WINDOW.HOUR]: { stepMs: 12_000, size: 300 },
  [RATE_WINDOW.TODAY]: { stepMs: 300_000, size: 288 },
})

/** @param {string} window @returns {window is RateWindow} */
export const isRateWindow = (window) => Object.hasOwn(RINGS, window)

const counts = { down: 0, up: 0, mirror: 0 }

/** @param {number} bytes @param {boolean} [mirror] the bytes were fetched by a mirrored folder */
export function countDownloaded(bytes, mirror = false) {
  if (!(bytes > 0)) return
  counts.down += bytes
  if (mirror) counts.mirror += bytes
}

/** @param {number} bytes */
export function countUploaded(bytes) {
  if (bytes > 0) counts.up += bytes
}

// What was counted since the last take.
export function takeCounts() {
  const taken = { ...counts }
  resetCounts()
  return taken
}

export function resetCounts() {
  counts.down = 0
  counts.up = 0
  counts.mirror = 0
}

// A download reports the bytes it holds so far, starting from what a resumed partial already had.
// The first report is therefore the baseline, never traffic; every later one counts its increase.
/** @param {(bytes: number) => void} count */
export function progressCounter(count) {
  /** @type {number | null} */
  let last = null
  return (/** @type {number} */ bytes) => {
    if (last !== null && bytes > last) count(bytes - last)
    last = bytes
  }
}

// One ring per window. A coarser ring stores the average of the one-second rates that fell into
// each of its steps, so a point is a rate whatever its width.
export function createRateHistory() {
  const rings = Object.entries(RINGS).map(([window, { stepMs, size }]) => ({
    window, stepMs, size, /** @type {RateSample[]} */ samples: [], open: /** @type {{ step: number, down: number, up: number, n: number } | null} */ (null),
  }))

  const close = (ring) => {
    const { step, down, up, n } = ring.open
    ring.samples.push({ t: (step + 1) * ring.stepMs, down: Math.round(down / n), up: Math.round(up / n) })
    if (ring.samples.length > ring.size) ring.samples.shift()
    ring.open = null
  }

  return {
    /** @param {number} now @param {number} down bytes per second @param {number} up bytes per second */
    push(now, down, up) {
      for (const ring of rings) {
        const step = Math.floor(now / ring.stepMs)
        if (ring.open && ring.open.step !== step) close(ring)
        if (!ring.open) ring.open = { step, down: 0, up: 0, n: 0 }
        ring.open.down += down
        ring.open.up += up
        ring.open.n++
        if (ring.stepMs <= 1000) close(ring)
      }
    },
    /**
     * The window's points, oldest first. `since` drops what is older, which is how "today" ends at
     * the last local midnight.
     * @param {RateWindow} window @param {number} [since] @returns {RateSample[]}
     */
    samples(window, since = 0) {
      const ring = rings.find((r) => r.window === window)
      return ring ? ring.samples.filter((s) => s.t >= since) : []
    },
  }
}
