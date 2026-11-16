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

/**
 * @param {number} at
 * @param {{ conns: object[], fetches: object[], serves: object[], host: object }} sample every entry
 *   already numbered: `c` on a connection and a serve, `x` and `[c, count]` holders on a fetch
 * @returns {string[]}
 */
export function sampleLines(at, { conns, fetches, serves, host }) {
  const lines = [
    ...conns.map((conn) => traceLine('conn', at, conn)),
    ...fetches.map((fetch) => traceLine('fetch', at, fetch)),
    ...serves.map((serve) => traceLine('serve', at, serve)),
    traceLine('host', at, host),
  ]
  return lines.filter((line) => line !== null)
}
