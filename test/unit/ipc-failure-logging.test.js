import test from 'brittle'
import { createIPC, getRequestFailureCounters, resetRequestFailureCounters, getRequestMetrics, resetRequestMetrics } from '../../src/shared/core/ipc.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'

// The router is strict about names it does not know, which is the point in production. A test
// declares the small vocabulary it exercises instead of registering into the real contract.
const TEST_REQUESTS = Object.freeze({
  'thing:sync-boom': { kind: 'command', args: {} },
  'thing:do': { kind: 'command', args: {} },
  'thing:ok': { kind: 'command', args: {} },
  'preview:make': { kind: 'command', args: {} },
  'a:do': { kind: 'command', args: {} },
  'b:do': { kind: 'command', args: {} },
})


// The router logs through createLogger, which writes to console.warn / console.log. Capturing both
// is the only way to assert the LEVEL, which is the entire point of this fix.
function captureConsole (t) {
  const warns = []
  const logs = []
  const origWarn = console.warn
  const origLog = console.log
  console.warn = (...a) => warns.push(a.join(' '))
  console.log = (...a) => logs.push(a.join(' '))
  t.teardown(() => { console.warn = origWarn; console.log = origLog })
  return { warns, logs }
}

// The router consumes NDJSON from pipe.on('data'); feed it the way the real pipe does.
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

function setup (t, { verbose = false } = {}) {
  const prev = getRuntimeConfig()
  setRuntimeConfig({ ...prev, verbose })
  resetRequestFailureCounters()
  t.teardown(() => { setRuntimeConfig(prev); resetRequestFailureCounters() })
  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS })
  return { ipc, pipe }
}

const flush = () => new Promise((r) => setTimeout(r, 20))

// REGRESSION (FIX-OBS-1: every failing IPC request was logged at debug while the default level is
// warn, so nothing that failed in the field was ever recoverable after the fact.)
test('REGRESSION (FIX-OBS-1): a failing request is logged at warn at the default level', async (t) => {
  const cap = captureConsole(t)
  const { ipc, pipe } = setup(t)
  ipc.handle('thing:do', async () => { const e = new Error('it broke'); e.code = 'EPATH'; throw e })
  ipc.start()

  pipe.feed({ id: 1, type: 'thing:do' })
  await flush()

  const failure = cap.warns.find((l) => l.includes('req-failed'))
  t.ok(failure, 'the failure reached console.warn')
  t.ok(failure.includes('req=thing:do'), 'carries the request type')
  t.ok(failure.includes('code=EPATH'), 'carries the error code')
  t.ok(failure.includes('it broke'), 'carries the message')
  t.ok(/ms=\d+/.test(failure), 'carries the duration')
})

test('the response still carries the code and message to the caller', async (t) => {
  captureConsole(t)
  const { ipc, pipe } = setup(t)
  ipc.handle('thing:do', async () => { const e = new Error('nope'); e.code = 'EPATH'; throw e })
  ipc.start()

  pipe.feed({ id: 7, type: 'thing:do' })
  await flush()

  const reply = JSON.parse(pipe.written.find((w) => w.includes('"id":7')))
  t.is(reply.code, 'EPATH')
  t.is(reply.error, 'nope')
})

test('an expected code stays at debug so the level keeps its meaning', async (t) => {
  const cap = captureConsole(t)
  const { ipc, pipe } = setup(t)
  ipc.handle('preview:make', async () => { const e = new Error('cancelled'); e.code = 'PREVIEW_CANCELLED'; throw e })
  ipc.start()

  pipe.feed({ id: 2, type: 'preview:make' })
  await flush()

  t.absent(cap.warns.find((l) => l.includes('req-failed')), 'no warn for ordinary control flow')
  t.is(getRequestFailureCounters()['preview:make:PREVIEW_CANCELLED'], 1, 'but it is still counted')
})

test('a successful request produces no warn', async (t) => {
  const cap = captureConsole(t)
  const { ipc, pipe } = setup(t)
  ipc.handle('thing:ok', async () => ({ fine: true }))
  ipc.start()

  pipe.feed({ id: 3, type: 'thing:ok' })
  await flush()

  t.is(cap.warns.length, 0, 'success is silent at the default level')
})

test('an unknown command warns and is counted', async (t) => {
  const cap = captureConsole(t)
  const { ipc, pipe } = setup(t)
  ipc.start()

  pipe.feed({ id: 4, type: 'nope:missing' })
  await flush()

  t.ok(cap.warns.find((l) => l.includes('req-unknown') && l.includes('nope:missing')), 'warned')
  t.is(getRequestFailureCounters()['unknown-command:NOT_FOUND'], 1, 'counted under a fixed bucket, not the caller-supplied name')
})

test('failures tally per type and code', async (t) => {
  captureConsole(t)
  const { ipc, pipe } = setup(t)
  ipc.handle('a:do', async () => { const e = new Error('x'); e.code = 'EPATH'; throw e })
  ipc.handle('b:do', async () => { throw new Error('no code') })
  ipc.start()

  pipe.feed({ id: 10, type: 'a:do' })
  pipe.feed({ id: 11, type: 'a:do' })
  pipe.feed({ id: 12, type: 'b:do' })
  await flush()

  const counters = getRequestFailureCounters()
  t.is(counters['a:do:EPATH'], 2, 'repeated failures accumulate')
  t.is(counters['b:do:UNKNOWN'], 1, 'a code-less error falls back to UNKNOWN')
})

// The type half of the key comes from the caller, and an unknown command used to be counted under
// whatever name it asked for — an unbounded map driven by input the router does not control.
test('the failure counter map is bounded', async (t) => {
  captureConsole(t)
  const { ipc, pipe } = setup(t)
  ipc.start()

  for (let i = 0; i < 400; i++) pipe.feed({ id: 1000 + i, type: 'ghost:' + i })
  await flush()

  const counters = getRequestFailureCounters()
  t.ok(Object.keys(counters).length <= 257, 'the map stayed capped')
  t.is(counters['unknown-command:NOT_FOUND'], 400, 'and unknown commands share one bucket')
})

// A handler that throws SYNCHRONOUSLY (not from an async body) escaped through
// `Promise.resolve(entry.fn(...))` — the call is evaluated before the promise exists, so the throw
// unwound into the frame-parse catch that wraps dispatch(). Three consequences, all silent:
// the caller got no response and hung to the renderer's 30s timeout, the failure was counted
// nowhere, and requestMetrics.begin() had already incremented inFlight with no settle to match.
// Only `shutdown` is non-async in the worker today, but the metrics leak is what makes this
// load-bearing here: a monotonically rising inFlight reads as saturation.
test('REGRESSION (FIX-R09-7): a synchronous handler throw is answered, counted, and settled', async (t) => {
  resetRequestFailureCounters()
  resetRequestMetrics()
  t.teardown(() => { resetRequestFailureCounters(); resetRequestMetrics() })
  const { warns } = captureConsole(t)
  setRuntimeConfig({ verbose: false })
  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS })
  ipc.handle('thing:sync-boom', () => { throw new Error('sync throw') })
  ipc.start()

  pipe.feed({ id: '1', type: 'thing:sync-boom' })
  await new Promise((r) => setImmediate(r))

  const res = pipe.written.map((s) => JSON.parse(s)).find((m) => m.id === '1')
  t.ok(res, 'the caller is answered rather than left to time out')
  t.is(res.code, 'UNKNOWN', 'with a code')
  t.is(res.error, 'sync throw', 'and the message')
  t.is(getRequestFailureCounters()['thing:sync-boom:UNKNOWN'], 1, 'the failure is counted')
  t.is(getRequestMetrics()['thing:sync-boom'].inFlight, 0, 'in-flight settles back to zero')
  t.is(getRequestMetrics()['thing:sync-boom'].failures, 1, 'and is recorded as a failure')
  t.absent(warns.some((l) => l.includes('unparseable')), 'never misreported as a malformed frame')
})

