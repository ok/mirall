// The transfer trace: once a second while a transfer runs, what the transport, the transfer engine
// and the host are doing, and each event as it happens, written as lines to a file in the data
// folder. It runs on the serving and on the fetching side alike, since the congestion figures exist
// only at the sender and the request and stash figures only at the receiver.
//
// Off unless the test run file turns it on: _open then installs nothing, the sink stays empty and
// every traceEvent call in the transfer path returns at once.
import os from 'bare-os'
import { Subsystem } from '../../core/subsystem.js'
import { isTransferTraceOn, getTestRunName, getAppVersionLabel, getStoragePath } from '../../core/runtime-config.js'
import { getOverlay, socketOfOverlayPeer } from '../overlay/overlay-instance.js'
import { TRACE_EVENTS, TRACE_VERSION, traceLine } from './trace-record.js'
import { createTraceNumbering, createServeActivity, sampleLines } from './trace-sample.js'
import { transportSample } from './transport-sample.js'
import { createTraceFile, traceDirFor } from './trace-file.js'
import { setTraceSink } from './trace-sink.js'

const SAMPLE_INTERVAL_MS = 1000
const EMPTY_SNAPSHOT = Object.freeze({ fetches: [], serves: [] })

// Share of one core, in percent, that `usage` microseconds are of `elapsedMs`.
function percentOf(usage, elapsedMs) {
  if (!(elapsedMs > 0)) return undefined
  return Math.round(((usage.user + usage.system) / (elapsedMs * 1000)) * 1000) / 10
}

export class TransferTrace extends Subsystem {
  async _open() {
    if (!isTransferTraceOn()) return
    this._file = createTraceFile({ dir: traceDirFor(getStoragePath()) })
    this._numbering = createTraceNumbering()
    this._movedServes = createServeActivity()
    this._connections = new Set()
    this._file.append([traceLine('header', Date.now(), {
      v: TRACE_VERSION, app: getAppVersionLabel(), run: getTestRunName(), platform: os.platform(), arch: os.arch(),
    })])
    this._expected = Date.now() + SAMPLE_INTERVAL_MS
    this._cpuAt = Date.now()
    this._cpu = os.cpuUsage()
    this._threadCpu = os.threadCpuUsage()
    setTraceSink((kind, fields) => this._onEvent(kind, fields))
    this.timers.setInterval(() => this._sample(), SAMPLE_INTERVAL_MS)
    this.log.info('recording to', this._file.file)
  }

  async _close() {
    setTraceSink(null)
  }

  _onEvent(kind, { socket, peer, key, n, ok }) {
    const conn = socket ?? (peer ? socketOfOverlayPeer(peer) : null)
    if (kind === TRACE_EVENTS.CONN_OPEN) this._connections.add(conn)
    if (kind === TRACE_EVENTS.CONN_CLOSE) this._connections.delete(conn)
    const line = traceLine('event', Date.now(), {
      e: kind, c: this._numbering.conn(conn), x: this._numbering.transfer(key), n, ok,
    })
    if (kind === TRACE_EVENTS.FETCH_END) this._numbering.forgetTransfer(key)
    if (line) this._file.append([line])
  }

  // The host figures are read on every tick, idle or not, so the first sample of a transfer covers
  // one interval rather than everything since the last transfer.
  _host(now) {
    const lagMs = Math.max(0, now - this._expected)
    this._expected = now + SAMPLE_INTERVAL_MS
    const elapsedMs = now - this._cpuAt
    const cpu = os.cpuUsage()
    const threadCpu = os.threadCpuUsage()
    const host = {
      lagMs,
      cpuPct: percentOf({ user: cpu.user - this._cpu.user, system: cpu.system - this._cpu.system }, elapsedMs),
      threadPct: percentOf({ user: threadCpu.user - this._threadCpu.user, system: threadCpu.system - this._threadCpu.system }, elapsedMs),
    }
    this._cpuAt = now
    this._cpu = cpu
    this._threadCpu = threadCpu
    return host
  }

  _sample() {
    const now = Date.now()
    const host = this._host(now)
    const snapshot = getOverlay()?.traceSnapshot() ?? EMPTY_SNAPSHOT
    const serves = this._movedServes(snapshot.serves)
    if (snapshot.fetches.length === 0 && serves.length === 0) return
    const connOf = (peer) => this._numbering.conn(socketOfOverlayPeer(peer))
    this._file.append(sampleLines(now, {
      conns: [...this._connections].map((socket) => ({ c: this._numbering.conn(socket), ...transportSample(socket.rawStream) })),
      fetches: snapshot.fetches.map(({ key, holders, ...counts }) => ({
        x: this._numbering.transfer(key), ...counts, holders: holders.map(([peer, count]) => [connOf(peer), count]),
      })),
      serves: serves.map(({ peer, ...counts }) => ({ c: connOf(peer), ...counts })),
      host,
    }))
  }
}
