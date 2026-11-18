// Samples the transfer byte counters once a second into the rate history and tells the renderer the
// current rate. A frame is sent while bytes move and once more when they stop, so an idle app sends
// nothing.
import { Subsystem } from '../core/subsystem.js'
import { RATE_WINDOW } from '../contract/rate-window.js'
import { createRateHistory, isRateWindow, resetCounts, takeCounts } from './transfer-rates.js'
/** @import { RateSample } from './transfer-rates.js' */

const SAMPLE_INTERVAL_MS = 1000
// A mirror fetches file by file with gaps between; the page's line should not flicker with them.
const MIRROR_HOLD_MS = 5000

let current = null

/**
 * The rate history for one window, oldest first; empty for a window it does not know and before
 * the meter runs.
 * @param {string} window @returns {RateSample[]}
 */
export function rateSamples(window) {
  if (!current || !isRateWindow(window)) return []
  const since = window === RATE_WINDOW.TODAY ? new Date().setHours(0, 0, 0, 0) : 0
  return current.history.samples(window, since)
}

export class TransferMeter extends Subsystem {
  constructor(name, deps) { super(name, deps); this.require('ipc') }

  async _open() {
    resetCounts()
    this.history = createRateHistory()
    this._at = Date.now()
    this._moving = false
    this._mirrorUntil = 0
    current = this
    this.timers.setInterval(() => this._sample(), SAMPLE_INTERVAL_MS)
  }

  async _close() {
    if (current === this) current = null
    resetCounts()
  }

  _sample(now = Date.now()) {
    const { down, up, mirror } = takeCounts()
    // Over the time that really passed: a late tick would otherwise read as a burst.
    const seconds = Math.max(now - this._at, SAMPLE_INTERVAL_MS) / 1000
    this._at = now
    const rate = { down: Math.round(down / seconds), up: Math.round(up / seconds) }
    this.history.push(now, rate.down, rate.up)
    if (mirror > 0) this._mirrorUntil = now + MIRROR_HOLD_MS
    const moving = rate.down > 0 || rate.up > 0
    if (moving || this._moving) this.deps.ipc.emit('event:transfer-rate', { ...rate, mirror: now < this._mirrorUntil })
    this._moving = moving
  }
}
