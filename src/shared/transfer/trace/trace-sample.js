// One second of a transfer as trace lines, and the numbering that keeps live objects out of them.
// The engine reports fetches by destination path and holders by peer object; here each becomes the
// per-session number the trace carries, and only the fields trace-record.js names are written.
//
// Pure, so a unit test drives it under Node.
import { traceLine } from './trace-record.js'

// A connection is numbered by its socket and a transfer by its destination path, both from 1 in the
// order first seen. The path is held in memory only, and dropped when its transfer ends.
export function createTraceNumbering() {
  const conns = new WeakMap()
  const transfers = new Map()
  let lastConn = 0
  let lastTransfer = 0
  return {
    /** @param {object | null | undefined} socket @returns {number | undefined} */
    conn(socket) {
      if (!socket) return undefined
      let c = conns.get(socket)
      if (!c) conns.set(socket, (c = ++lastConn))
      return c
    },
    /** @param {string | null | undefined} key @returns {number | undefined} */
    transfer(key) {
      if (!key) return undefined
      let x = transfers.get(key)
      if (!x) transfers.set(key, (x = ++lastTransfer))
      return x
    },
    forgetTransfer(key) { transfers.delete(key) },
  }
}

// The serves that moved bytes or have a request waiting since the last look. A served peer's counts
// stay until its connection closes, so without this an idle peer would keep the trace sampling.
export function createServeActivity() {
  const lastBytes = new WeakMap()
  return function movedServes(serves) {
    return serves.filter(({ peer, bytes, queued }) => {
      const moved = bytes !== (lastBytes.get(peer) ?? 0)
      lastBytes.set(peer, bytes)
      return moved || queued > 0
    })
  }
}

// udx reports its retransmit, fast-recovery and lifetime-timeout counts through 16-bit views, so
// each returns to zero after 65,535. A count that reads lower than it last did has gone round once
// more; the trace carries the running total. A second samples far fewer than 65,536 of any of them.
const WRAPPING_COUNTS = ['retransmits', 'fastRecoveries', 'rtoLifetime']
const WRAP = 65536

export function createWrapCorrection() {
  const seen = new WeakMap()
  /** @param {object} socket @param {Record<string, number>} sample @returns {Record<string, number>} */
  return function corrected(socket, sample) {
    let counts = seen.get(socket)
    if (!counts) seen.set(socket, (counts = {}))
    const out = { ...sample }
    for (const name of WRAPPING_COUNTS) {
      const raw = sample[name]
      if (raw === undefined) continue
      const count = (counts[name] ??= { last: raw, carried: 0 })
      if (raw < count.last) count.carried += WRAP
      count.last = raw
      out[name] = raw + count.carried
    }
    return out
  }
}

/**
 * @param {number} at
 * @param {{ conns: object[], fetches: object[], serves: object[], checks?: object[], host: object }} sample every entry
 *   already numbered: `c` on a connection and a serve, `x` and `[c, count]` holders on a fetch
 * @returns {string[]}
 */
export function sampleLines(at, { conns, fetches, serves, checks = [], host }) {
  const lines = [
    ...conns.map((conn) => traceLine('conn', at, conn)),
    ...fetches.map((fetch) => traceLine('fetch', at, fetch)),
    ...serves.map((serve) => traceLine('serve', at, serve)),
    ...checks.map((check) => traceLine('check', at, check)),
    traceLine('host', at, host),
  ]
  return lines.filter((line) => line !== null)
}
