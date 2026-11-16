// Where the transfer trace's events come in. The sources (the engine's hooks, the connection attach
// point, the fetch wrapper) call traceEvent with the live objects they have (a socket, an engine
// peer, a destination path); the trace subsystem installs the sink that turns those into numbers and
// writes the line. With no sink installed, which is every run without a test run file, a call does
// nothing and no listener is attached.
import { TRACE_EVENTS } from './trace-record.js'

let sink = null

/** @param {((kind: string, fields: object) => void) | null} next */
export function setTraceSink(next) {
  sink = next
}

/** @param {string} kind a TRACE_EVENTS member @param {{ socket?: object, peer?: object, key?: string, n?: number, ok?: boolean }} [fields] */
export function traceEvent(kind, fields = {}) {
  if (!sink) return
  try { sink(kind, fields) } catch {}
}

// A connection that can carry a transfer: its opening, its closing and each change of the path its
// transport takes.
export function traceConnection(socket) {
  if (!sink) return
  traceEvent(TRACE_EVENTS.CONN_OPEN, { socket })
  socket.once('close', () => traceEvent(TRACE_EVENTS.CONN_CLOSE, { socket }))
  socket.rawStream?.on?.('remote-changed', () => traceEvent(TRACE_EVENTS.CONN_PATH, { socket }))
}
