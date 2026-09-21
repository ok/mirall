// Coalesces a burst of one alert into one notification. The hit that opens an episode is shown at
// once; later hits under the same key only count. An episode closes `windowMs` after its last hit,
// and never later than `capMs` after its first, so a steady stream still reports. The caller owns
// the timers: it waits until closesAt(key), then settle(key) hands back the episode's count.
// Plain JS so it unit-tests in the Node runner without the dispatcher's i18n/ipc deps.

/** @typedef {{ first: number, last: number, count: number }} Episode */

/** @param {{ windowMs: number, capMs: number, now?: () => number }} opts */
export function createCoalescer({ windowMs, capMs, now = Date.now }) {
  /** @type {Map<string, Episode>} */
  const episodes = new Map()
  /** @param {Episode} e */
  const closingTime = (e) => Math.min(e.last + windowMs, e.first + capMs)

  return {
    /** @param {string} key @returns {boolean} whether this hit opens an episode and is shown */
    hit(key) {
      const t = now()
      const e = episodes.get(key)
      if (e && t < closingTime(e)) {
        e.count += 1
        e.last = t
        return false
      }
      episodes.set(key, { first: t, last: t, count: 1 })
      return true
    },
    /** @param {string} key @returns {number | null} */
    closesAt(key) {
      const e = episodes.get(key)
      return e ? closingTime(e) : null
    },
    /** @param {string} key @returns {number | null} the closed episode's count; null while open */
    settle(key) {
      const e = episodes.get(key)
      if (!e || now() < closingTime(e)) return null
      episodes.delete(key)
      return e.count
    },
  }
}
