// An age as the largest whole unit Intl.RelativeTimeFormat can say, for every "N ago" the renderer
// shows. `smallest` is the finest unit a caller names: below it the age reads as 0 of that unit,
// which Intl's `numeric: 'auto'` says as "now" or "today". A time ahead of `now` reads as 0.

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** @typedef {'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'} AgeUnit */
/** @typedef {{ value: number, unit: AgeUnit }} RelativeAge */

const FINE = ['second', 'minute', 'hour']

/**
 * @param {number} ms how long ago
 * @param {{ smallest?: 'second' | 'day' }} [opts]
 * @returns {RelativeAge}
 */
export function relativeAge(ms, { smallest = 'second' } = {}) {
  const age = Math.max(0, ms)
  if (FINE.includes(smallest) && age < DAY) {
    if (age < MINUTE) return { value: 0, unit: 'second' }
    if (age < HOUR) return { value: Math.floor(age / MINUTE), unit: 'minute' }
    return { value: Math.floor(age / HOUR), unit: 'hour' }
  }
  const days = Math.floor(age / DAY)
  if (days < 7) return { value: days, unit: 'day' }
  if (days < 30) return { value: Math.floor(days / 7), unit: 'week' }
  if (days < 365) return { value: Math.floor(days / 30), unit: 'month' }
  return { value: Math.floor(days / 365), unit: 'year' }
}
