// Coalesces a burst of one alert into one notification. The first hit under a key opens an episode
// and is reported at once (onLeading); later hits only count, by distinct id, so a retry of the same
// transfer is not a second file. The episode ends after `windowMs` without a hit, reporting the
// count if it grew (onSummary). A stream that never goes quiet is reported cumulatively at most once
// per `capMs`, always as the same episode. The clock is monotonic so a sleep or a clock change
// cannot desync it from the timers.
// Plain JS so it unit-tests in the Node runner without the dispatcher's i18n/ipc deps.

/**
 * @template T
 * @typedef {{ seq: number, count: number, data: T }} Episode
 */

/**
 * @template T
 * @param {{
 *   windowMs: number,
 *   capMs: number,
 *   onLeading: (episode: Episode<T>) => void,
 *   onSummary: (episode: Episode<T>) => void,
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>,
 *   clearTimer?: (timer: ReturnType<typeof setTimeout>) => void,
 * }} opts
 */
export function createCoalescer({ windowMs, capMs, onLeading, onSummary, now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  /** @typedef {{ seq: number, ids: Set<string>, data: T, last: number, reportedAt: number, reported: number, timer: ReturnType<typeof setTimeout> | null }} Open */
  /** @type {Map<string, Open>} */
  const open = new Map()
  let seq = 0

  /** @param {Open} ep @returns {Episode<T>} */
  const view = (ep) => ({ seq: ep.seq, count: ep.ids.size, data: ep.data })
  /** @param {Open} ep */
  const dueAt = (ep) => Math.min(ep.last + windowMs, ep.reportedAt + capMs)

  /** @param {string} key @param {Open} ep */
  function schedule(key, ep) {
    if (ep.timer) clearTimer(ep.timer)
    ep.timer = setTimer(() => fire(key, ep), Math.max(0, dueAt(ep) - now()))
  }

  /** @param {string} key @param {Open} ep */
  function fire(key, ep) {
    ep.timer = null
    const t = now()
    if (t < dueAt(ep)) { schedule(key, ep); return }
    if (ep.ids.size > ep.reported) {
      ep.reported = ep.ids.size
      onSummary(view(ep))
    }
    ep.reportedAt = t
    if (t >= ep.last + windowMs) open.delete(key)
    else schedule(key, ep)
  }

  return {
    /** @param {string} key @param {string} id @param {T} data */
    hit(key, id, data) {
      const t = now()
      const ep = open.get(key)
      if (ep) {
        ep.ids.add(id)
        ep.data = data
        ep.last = t
        schedule(key, ep)
        return
      }
      seq += 1
      const fresh = { seq, ids: new Set([id]), data, last: t, reportedAt: t, reported: 1, timer: null }
      open.set(key, fresh)
      onLeading(view(fresh))
      schedule(key, fresh)
    },
    close() {
      for (const ep of open.values()) if (ep.timer) clearTimer(ep.timer)
      open.clear()
    },
  }
}
