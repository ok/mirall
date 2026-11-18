// The path check: a fixed amount of generated data sent over a content connection with the
// transfer engine left out, so a test can tell what the connection carries from what a transfer
// gets out of it. No file is read or written, nothing is hashed and no chunk is scheduled; the
// bytes ride the same encrypted, multiplexed stream a transfer does, each frame waiting for the
// stream to drain as a served chunk does, and the transfer trace samples the connection while they
// move.
//
// It exists only when the test run file turns it on: without the lever no channel is opened, so
// two peers must both carry it before either can ask. The side whose file also names an amount
// asks once per run, on the first content connection that answers; the other side sends, and only
// to a socket a member has authenticated on.
import c from 'compact-encoding'
import crypto from 'hypercore-crypto'
import { getTransferLevers } from '../core/runtime-config.js'
import { createLogger } from '../core/logger.js'
import { traceEvent } from './trace/trace-sink.js'
import { TRACE_EVENTS } from './trace/trace-record.js'

const log = createLogger('path-check')

const PROTOCOL = 'mirall/path-check'
const FRAME_BYTES = 256 * 1024
// The most one request may ask for, whatever the asker's own file allows.
const MAX_BYTES = 64 * 1024 * 1024 * 1024
// A request can arrive before the asker's content-hello is verified; it waits this long for it.
const AUTH_WAIT_MS = 10_000
const AUTH_POLL_MS = 250
// Cede the worker loop this often while the stream keeps taking frames without backpressure.
const YIELD_EVERY = 16

// socket → { totalBytes, rxBytes | txBytes, startedAt }: the checks in flight, for the trace.
const active = new Map()
let asked = false
let frame = null

const yieldToLoop = () => new Promise((resolve) => setTimeout(resolve, 0))

// Resolves true when the backpressured stream has drained, false when it closed first. No budget
// of its own: a peer that stops taking bytes is closed by the connection's keep-alive.
function drained({ channel, mux }) {
  const stream = mux.stream
  return new Promise((resolve) => {
    const done = (alive) => {
      stream.removeListener('drain', onDrain)
      stream.removeListener('close', onClose)
      resolve(alive)
    }
    // Deferred like a served chunk's drain wait when the test run file says so (transport-probe.js).
    const onDrain = () => (getTransferLevers().deferDrain ? setImmediate(() => done(!channel.closed)) : done(!channel.closed))
    const onClose = () => done(false)
    stream.on('drain', onDrain)
    stream.on('close', onClose)
  })
}

const megabytesPerSecond = (bytes, ms) => (ms > 0 ? (bytes / 1e6 / (ms / 1000)).toFixed(1) : '0')

function finish(socket, ok) {
  const check = active.get(socket)
  if (!check) return
  active.delete(socket)
  const moved = check.rxBytes ?? check.txBytes
  const ms = Date.now() - check.startedAt
  log.info(`${check.rxBytes === undefined ? 'sent' : 'received'} ${moved} of ${check.totalBytes} bytes in ${ms} ms, ${megabytesPerSecond(moved, ms)} MB/s${ok ? '' : ' (cut short)'}`)
  traceEvent(TRACE_EVENTS.CHECK_END, { socket, ok })
}

function start(socket, check) {
  active.set(socket, { ...check, startedAt: Date.now() })
  traceEvent(TRACE_EVENTS.CHECK_START, { socket })
}

async function authenticatedWithin(socket, channel, authenticated) {
  for (let waited = 0; waited < AUTH_WAIT_MS && !channel.closed; waited += AUTH_POLL_MS) {
    if (authenticated()) return true
    await new Promise((resolve) => setTimeout(resolve, AUTH_POLL_MS))
  }
  return !channel.closed && authenticated()
}

async function send(socket, peer, data, totalBytes) {
  frame ??= crypto.randomBytes(FRAME_BYTES)
  start(socket, { totalBytes, txBytes: 0 })
  const check = active.get(socket)
  let frames = 0
  while (check.txBytes < totalBytes && !peer.channel.closed) {
    if (peer.channel.drained === false && !(await drained(peer))) break
    const size = Math.min(FRAME_BYTES, totalBytes - check.txBytes)
    data.send(size === FRAME_BYTES ? frame : frame.subarray(0, size))
    check.txBytes += size
    if (++frames % YIELD_EVERY === 0) await yieldToLoop()
  }
  finish(socket, check.txBytes === totalBytes)
}

/**
 * Opens the path-check channel on a content connection. Called synchronously where the connection
 * is attached, since protomux pairs a channel only if both sides open it before the stream flows.
 * @param {object} mux the connection's protomux
 * @param {object} socket the content socket
 * @param {() => boolean} authenticated whether a member has authenticated on this socket
 */
export function attachPathCheck(mux, socket, authenticated) {
  const levers = getTransferLevers()
  if (!levers.pathCheck) return
  const channel = mux.createChannel({
    protocol: PROTOCOL,
    onopen() {
      if (asked || !levers.pathCheckBytes) return
      asked = true
      start(socket, { totalBytes: levers.pathCheckBytes, rxBytes: 0 })
      request.send(levers.pathCheckBytes)
    },
    onclose() { finish(socket, false) },
  })
  if (!channel) return
  const peer = { channel, mux }
  const request = channel.addMessage({
    encoding: c.uint,
    async onmessage(totalBytes) {
      if (active.has(socket) || !Number.isInteger(totalBytes) || totalBytes < 1 || totalBytes > MAX_BYTES) return
      if (!(await authenticatedWithin(socket, channel, authenticated)) || active.has(socket)) return
      send(socket, peer, data, totalBytes).catch((err) => { log.warn('send failed:', err.message); finish(socket, false) })
    },
  })
  const data = channel.addMessage({
    encoding: c.raw,
    onmessage(bytes) {
      const check = active.get(socket)
      if (!check || check.rxBytes === undefined) return
      check.rxBytes += bytes.byteLength
      if (check.rxBytes >= check.totalBytes) finish(socket, true)
    },
  })
  channel.open()
}

// The checks in flight, for the trace's once-a-second sample.
/** @returns {{ socket: object, totalBytes: number, rxBytes?: number, txBytes?: number }[]} */
export function pathCheckSnapshot() {
  return [...active].map(([socket, { totalBytes, rxBytes, txBytes }]) => ({ socket, totalBytes, rxBytes, txBytes }))
}

export function resetPathCheck() {
  active.clear()
  asked = false
}
