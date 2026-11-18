// The time each speed chart window's width covers.
import { RATE_WINDOW } from '../../shared/contract/rate-window.js'
/** @import { RateWindow } from '../../shared/contract/rate-window.js' */

const SPAN_MS = { [RATE_WINDOW.MINUTES]: 5 * 60_000, [RATE_WINDOW.HOUR]: 60 * 60_000 }

// "Today" runs from the last local midnight; the other two end now and reach back their length.
/** @param {RateWindow} window @param {number} now @returns {{ start: number, end: number }} */
export function windowSpan(window, now) {
  if (window === RATE_WINDOW.TODAY) return { start: new Date(now).setHours(0, 0, 0, 0), end: now }
  return { start: now - SPAN_MS[window], end: now }
}
