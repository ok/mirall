import test from 'brittle'
import { traceLine, TRACE_EVENTS, TRACE_VERSION } from '../../src/shared/transfer/trace/trace-record.js'
import { createTraceNumbering, createServeActivity, sampleLines } from '../../src/shared/transfer/trace/trace-sample.js'
import { transportSample } from '../../src/shared/transfer/trace/transport-sample.js'
import { setTraceSink, traceEvent, traceConnection } from '../../src/shared/transfer/trace/trace-sink.js'

const HASH = 'a3f1c2d4e5b60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
const PRIVATE = ['/Users/someone/Downloads/report.pdf', 'report.pdf', HASH, HASH.slice(0, 16), '192.168.0.7', 'someone']

// A trace leaves the machine in a support bundle. Whatever a caller hands a line, nothing that can
// name a file, a person, a peer or a place may come out the other side.
test('no line carries a name, a path, a hash, a key or an address, whatever it is handed', (t) => {
  const smuggled = Object.fromEntries(PRIVATE.map((value, i) => ['extra' + i, value]))
  const everyField = {
    v: PRIVATE[0], app: PRIVATE[2], run: PRIVATE[0], platform: PRIVATE[5], arch: PRIVATE[4],
    c: PRIVATE[4], x: PRIVATE[0], e: PRIVATE[1], n: PRIVATE[2], ok: PRIVATE[5],
    mtu: PRIVATE[0], rtt: PRIVATE[2], pacing: PRIVATE[1], holders: [[PRIVATE[2], PRIVATE[4]], PRIVATE[0]],
    path: PRIVATE[0], key: PRIVATE[2], from: PRIVATE[2], contentHash: PRIVATE[2], host: PRIVATE[4],
    ...smuggled,
  }
  for (const kind of ['header', 'conn', 'fetch', 'serve', 'host', 'event']) {
    const line = traceLine(kind, 1000, everyField)
    if (line === null) continue
    for (const value of PRIVATE) t.absent(line.includes(value), `${kind} dropped "${value.slice(0, 20)}"`)
  }
  t.is(traceLine('event', 1000, everyField), null, 'an event with no known kind is not written at all')
})

test('a line keeps exactly the fields its kind names, typed', (t) => {
  t.alike(JSON.parse(traceLine('header', 5, { v: TRACE_VERSION, app: '1.14.0-beta.90', run: 'R3', platform: 'darwin', arch: 'arm64' })),
    { t: 5, k: 'header', v: 1, app: '1.14.0-beta.90', run: 'R3', platform: 'darwin', arch: 'arm64' })
  t.alike(JSON.parse(traceLine('conn', 6, { c: 1, cwnd: 40, rtt: 23, mtu: 1380, unknown: 9, retransmits: NaN })),
    { t: 6, k: 'conn', c: 1, mtu: 1380, rtt: 23, cwnd: 40 }, 'an unnamed field and a non-finite number are dropped')
  t.alike(JSON.parse(traceLine('fetch', 7, { x: 2, needed: 10, pacing: false, holders: [[1, 8], [2, 'x'], 'bad'] })),
    { t: 7, k: 'fetch', x: 2, needed: 10, pacing: false, holders: [[1, 8]] })
  t.alike(JSON.parse(traceLine('event', 8, { e: TRACE_EVENTS.HANDBACK, c: 1, x: 2, n: 8 })),
    { t: 8, k: 'event', e: 'handback', c: 1, x: 2, n: 8 })
  t.is(traceLine('nonsense', 9, {}), null)
  t.is(traceLine('host', NaN, { lagMs: 1 }), null, 'a line needs its time')
})

// The engine names its own events as plain strings: it cannot import the app's vocabulary.
test('the engine\'s event names are trace events', (t) => {
  for (const kind of ['handback', 'watchdog', 'drain-abandoned']) {
    t.ok(traceLine('event', 1, { e: kind }), kind)
  }
})

test('connections and transfers are numbered from 1 in the order first seen', (t) => {
  const numbering = createTraceNumbering()
  const a = {}
  const b = {}
  t.is(numbering.conn(a), 1)
  t.is(numbering.conn(b), 2)
  t.is(numbering.conn(a), 1, 'a connection keeps its number')
  t.is(numbering.conn(null), undefined)
  t.is(numbering.transfer('/dl/one'), 1)
  t.is(numbering.transfer('/dl/two'), 2)
  numbering.forgetTransfer('/dl/one')
  t.is(numbering.transfer('/dl/one'), 3, 'a transfer started again is a new transfer')
  t.is(numbering.transfer(undefined), undefined)
})

test('a served peer counts as active only while bytes move or a request waits', (t) => {
  const moved = createServeActivity()
  const peer = {}
  t.is(moved([{ peer, bytes: 100, queued: 0 }]).length, 1, 'bytes moved since the start')
  t.is(moved([{ peer, bytes: 100, queued: 0 }]).length, 0, 'nothing moved, nothing waiting')
  t.is(moved([{ peer, bytes: 100, queued: 1 }]).length, 1, 'a request is waiting')
  t.is(moved([{ peer, bytes: 250, queued: 0 }]).length, 1)
})

test('one second becomes one line per connection, fetch and serve, and one for the host', (t) => {
  const lines = sampleLines(42, {
    conns: [{ c: 1, cwnd: 10 }, { c: 2, cwnd: 20 }],
    fetches: [{ x: 1, needed: 3, holders: [[1, 3]] }],
    serves: [{ c: 2, queued: 1, bytes: 9 }],
    host: { lagMs: 4, cpuPct: 31.5, threadPct: 30 },
  }).map((line) => JSON.parse(line))
  t.alike(lines.map((line) => line.k), ['conn', 'conn', 'fetch', 'serve', 'host'])
  t.ok(lines.every((line) => line.t === 42), 'every line of a second carries the same time')
})

test('a transport is read figure by figure, and one that cannot be read is left out', (t) => {
  const stream = {
    mtu: 1380, rtt: 21, cwnd: 64, inflight: 12, rtoCount: 0, lifetimeRtoCount: 2, retransmits: 5, fastRecoveries: 1,
    bbrState: 2, bytesReceived: 1000, bytesTransmitted: 2000, packetsReceived: 10, packetsTransmitted: 20,
    get bbrBandwidth() { throw new Error('stream closed') },
    socket: { packetsDroppedByKernel: 7, getRecvBufferSize: () => 786896, getSendBufferSize() { throw new Error('Socket not active') } },
  }
  t.alike(transportSample(stream), {
    mtu: 1380, rtt: 21, cwnd: 64, inflight: 12, rto: 0, rtoLifetime: 2, retransmits: 5, fastRecoveries: 1,
    bbrState: 2, rxBytes: 1000, txBytes: 2000, rxPackets: 10, txPackets: 20, kernelDrops: 7, recvBuffer: 786896,
  })
  t.alike(transportSample({ bytesRead: 5 }), {}, 'a transport that is not udx reports nothing')
  t.alike(transportSample(null), {})
})

test('with no sink installed an event does nothing and a connection gets no listener', (t) => {
  let listeners = 0
  const socket = { once() { listeners++ }, rawStream: { on() { listeners++ } } }
  traceEvent(TRACE_EVENTS.CONN_OPEN, { socket })
  traceConnection(socket)
  t.is(listeners, 0)

  const seen = []
  setTraceSink((kind) => seen.push(kind))
  t.teardown(() => setTraceSink(null))
  traceConnection(socket)
  t.alike(seen, ['conn-open'])
  t.is(listeners, 2, 'its close and its path changes are watched')
  setTraceSink(() => { throw new Error('disk full') })
  t.execution(() => traceEvent(TRACE_EVENTS.WATCHDOG, {}), 'a failing sink never reaches the transfer path')
})
