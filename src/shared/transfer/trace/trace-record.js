// The lines a transfer trace can hold, each built from an allow-list: a field that is not named
// here is dropped, a number field takes a finite number, a flag a boolean, and a word only a member
// of its own vocabulary. A trace leaves the machine in a support bundle, so no line can carry a file
// name, a path, a content hash, a peer key or an address: a connection and a transfer are the
// per-session numbers `c` and `x`, and nothing free-form has a field to ride in.
//
// Pure, so a unit test drives it under Node.

export const TRACE_VERSION = 1

export const TRACE_EVENTS = Object.freeze({
  CONN_OPEN: 'conn-open',
  CONN_CLOSE: 'conn-close',
  CONN_PATH: 'conn-path',
  FETCH_START: 'fetch-start',
  FETCH_END: 'fetch-end',
  SERVE_START: 'serve-start',
  SERVE_END: 'serve-end',
  HANDBACK: 'handback',
  WATCHDOG: 'watchdog',
  DRAIN_ABANDONED: 'drain-abandoned',
})

const EVENT_WORDS = new Set(Object.values(TRACE_EVENTS))
const PLATFORM_WORDS = new Set(['darwin', 'linux', 'win32'])
const ARCH_WORDS = new Set(['arm64', 'x64'])
const VERSION = /^\d+\.\d+\.\d+(-[a-z]+\.\d+)?$/
const RUN_NAME = /^[A-Za-z0-9_-]{1,32}$/

const num = (v) => (Number.isFinite(v) ? v : undefined)
const flag = (v) => (typeof v === 'boolean' ? v : undefined)
const wordIn = (words) => (v) => (words.has(v) ? v : undefined)
const matching = (pattern) => (v) => (typeof v === 'string' && pattern.test(v) ? v : undefined)
// [connection, count] pairs: which connection holds how many of a fetch's chunks in flight.
const pairs = (v) => {
  if (!Array.isArray(v)) return undefined
  const kept = v.filter((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))
  return kept.map(([c, n]) => [c, n])
}

const SHAPES = Object.freeze({
  header: { v: num, app: matching(VERSION), run: matching(RUN_NAME), platform: wordIn(PLATFORM_WORDS), arch: wordIn(ARCH_WORDS) },
  conn: {
    c: num, mtu: num, rtt: num, cwnd: num, inflight: num, rto: num, rtoLifetime: num, retransmits: num,
    fastRecoveries: num, bbrState: num, bbrBandwidth: num, rxBytes: num, txBytes: num, rxPackets: num,
    txPackets: num, kernelDrops: num, recvBuffer: num, sendBuffer: num,
  },
  fetch: {
    x: num, needed: num, inflight: num, pacing: flag, rxBytes: num, totalBytes: num, stashBytes: num,
    readbacks: num, stashHits: num, hashLag: num, writeMs: num, hashMs: num, holders: pairs,
  },
  serve: { c: num, queued: num, chunks: num, bytes: num, readMs: num, drainMs: num, drainWaits: num },
  host: { lagMs: num, cpuPct: num, threadPct: num },
  event: { e: wordIn(EVENT_WORDS), c: num, x: num, n: num, ok: flag },
})

/** @typedef {keyof typeof SHAPES} TraceKind */

/**
 * One trace line, without its newline, or null when the kind is unknown or an event names none.
 * @param {TraceKind} kind
 * @param {number} at
 * @param {Record<string, unknown>} fields
 * @returns {string | null}
 */
export function traceLine(kind, at, fields) {
  const shape = SHAPES[kind]
  if (!shape || !Number.isFinite(at)) return null
  const line = { t: at, k: kind }
  for (const [name, take] of Object.entries(shape)) {
    const value = take(fields?.[name])
    if (value !== undefined) line[name] = value
  }
  if (kind === 'event' && line.e === undefined) return null
  return JSON.stringify(line)
}
