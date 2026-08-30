import test from 'brittle'
import { createIPC, getRequestMetrics, resetRequestMetrics } from '../../src/shared/core/ipc.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { ARG } from '../../src/shared/contract/requests.js'

const TEST_REQUESTS = Object.freeze({
  'thing:do': { kind: 'command', args: { spaceId: { type: ARG.spaceId, optional: true } } },
  'thing:strict': { kind: 'command', args: { count: { type: ARG.number } } },
})

function fakePipe () {
  const written = []
  let onData = null
  return {
    write: (s) => { written.push(s); return true },
    on: (evt, fn) => { if (evt === 'data') onData = fn },
    feed: (obj) => onData(Buffer.from(JSON.stringify(obj) + '\n')),
    written,
  }
}

function setup (t) {
  const prev = getRuntimeConfig()
  setRuntimeConfig({ ...prev, verbose: false })
  resetRequestMetrics()
  const origWarn = console.warn
  console.warn = () => {}
  t.teardown(() => { console.warn = origWarn; setRuntimeConfig(prev); resetRequestMetrics() })
  const pipe = fakePipe()
  return { ipc: createIPC(pipe, { requests: TEST_REQUESTS }), pipe }
}

const flush = () => new Promise((r) => setTimeout(r, 20))

test('a successful request is recorded', async (t) => {
  const { ipc, pipe } = setup(t)
  ipc.handle('thing:do', async () => ({ ok: true }))
  ipc.start()

  pipe.feed({ id: 1, type: 'thing:do' })
  await flush()

  const row = getRequestMetrics()['thing:do']
  t.is(row.calls, 1)
  t.is(row.failures, 0)
  t.is(row.inFlight, 0, 'settled')
  t.ok(row.avgMs >= 0, 'timing was captured')
})

test('a rejecting handler is recorded as a failure but still a call', async (t) => {
  const { ipc, pipe } = setup(t)
  ipc.handle('thing:do', async () => { throw new Error('nope') })
  ipc.start()

  pipe.feed({ id: 2, type: 'thing:do' })
  await flush()

  const row = getRequestMetrics()['thing:do']
  t.is(row.calls, 1)
  t.is(row.failures, 1)
})

// A payload refused by the validator never reaches entry.fn, so counting it as an in-flight request
// would leave inFlight permanently above zero — the number that is supposed to say "something is
// stuck" would say it forever.
test('a request refused by validation never enters the metrics', async (t) => {
  const { ipc, pipe } = setup(t)
  let ran = 0
  ipc.handle('thing:strict', async () => { ran += 1 })
  ipc.start()

  pipe.feed({ id: 3, type: 'thing:strict' })
  await flush()

  t.is(ran, 0, 'the handler never ran')
  t.absent(getRequestMetrics()['thing:strict'], 'and no row was opened for it')
})

test('inFlight is observable while a request is running', async (t) => {
  const { ipc, pipe } = setup(t)
  let release
  ipc.handle('thing:do', () => new Promise((r) => { release = r }))
  ipc.start()

  pipe.feed({ id: 4, type: 'thing:do' })
  await flush()
  t.is(getRequestMetrics()['thing:do'].inFlight, 1, 'a parked request is visible as in flight')

  release({ done: true })
  await flush()
  t.is(getRequestMetrics()['thing:do'].inFlight, 0, 'and clears when it settles')
})

// The seam cancellation (r07-3) will use. Adding it now costs one line; adding it later means
// touching all 86 handlers.
test('the handler receives a context carrying its request id', async (t) => {
  const { ipc, pipe } = setup(t)
  let ctx = null
  ipc.handle('thing:do', async (_msg, c) => { ctx = c; return {} })
  ipc.start()

  pipe.feed({ id: 42, type: 'thing:do' })
  await flush()

  t.is(ctx.id, 42, 'the request id reaches the handler')
  t.is(ctx.signal, null, 'signal is the seam, null until cancellation is wired')
})

test('metrics are kept per request type', async (t) => {
  const { ipc, pipe } = setup(t)
  ipc.handle('thing:do', async () => ({}))
  ipc.handle('thing:strict', async () => { throw new Error('x') })
  ipc.start()

  pipe.feed({ id: 5, type: 'thing:do' })
  pipe.feed({ id: 6, type: 'thing:strict', count: 1 })
  await flush()

  const snap = getRequestMetrics()
  t.is(snap['thing:do'].failures, 0)
  t.is(snap['thing:strict'].failures, 1, 'a failure in one type does not leak into another')
})

// REGRESSION (FIX-DIAG-DROP: buildDiagnostics destructures the fields it carries, so a key the
// caller adds but the builder does not name is silently dropped. #118's requestFailures shipped
// that way — counted correctly, surfaced nowhere — and the metrics added here would have too. The
// unit suite was green throughout, because nothing covered the hop.)
test('REGRESSION (FIX-DIAG-DROP): the bundle carries the request counters', async (t) => {
  const { buildDiagnostics } = await import('../../src/shared/transfer/diagnostics.js')
  const ctx = {
    status: {
      reachability: null, dhtReady: true, announced: true,
      address: { publicHost: null, publicPort: 0 },
      nat: {}, routing: { tableSize: 0, bootstrap: [] }, dhtHealth: null,
      identity: { publicKey: 'k', nodeId: 'n' },
      peerReach: { discovered: 0, connected: 0, exhausted: 0 },
      stats: { connects: { client: 0, server: 0 }, bannedPeers: 0, relaying: null },
      canary: null, liveness: null, topics: 0,
    },
    history: [], env: { appVersion: '0', platform: 'test', release: '', arch: '' },
    counters: { readyAt: 0, bootedAt: 0, hostChangeCount: 0, localPortStable: true },
    peerSamples: [],
    requestMetrics: { 'thing:do': { calls: 3, failures: 1, inFlight: 0, avgMs: 5, maxMs: 9, slow: 0 } },
    requestFailures: { 'thing:do:EPATH': 1 },
  }

  const bundle = buildDiagnostics(ctx, true)
  t.ok(bundle.requests, 'the bundle has a requests section')
  t.is(bundle.requests.metrics['thing:do'].calls, 3, 'metrics survive the hop')
  t.is(bundle.requests.failures['thing:do:EPATH'], 1, 'so do the failure counters')
})
