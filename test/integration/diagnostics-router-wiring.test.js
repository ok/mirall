import test from 'brittle'
import { createIPC } from '../../src/shared/core/ipc.js'
import { createHealthMonitor } from '../../src/shared/core/health.js'
import { registerDiagnostics } from '../../src/worker/ipc/diagnostics.js'
import { freshDurable } from '../helpers/store.js'

// The producer being correct proves nothing about the export: requestFailures and requestMetrics were
// both built, tested and shipped as no-ops because nothing handed them to buildDiagnostics. The
// router's own numbers travel that same hop — createIPC → registerDiagnostics → health.snapshot →
// buildDiagnostics — so it is asserted on the VALUE that comes out rather than on the text of the
// call site. Integration rather than unit because worker/ipc/diagnostics.js imports bare-os, and the
// handler reads the sweep journal, which needs a real store.

const QUEUE_REQUESTS = Object.freeze({ 'q:one': { kind: 'command', args: {} } })

// Only the two members createIPC touches — Bare has no `events` module.
function fakePipe() {
  let onData = () => {}
  return {
    on: (event, fn) => { if (event === 'data') onData = fn },
    write: () => true,
    feed: (obj) => onData(Buffer.from(JSON.stringify(obj) + '\n')),
  }
}

const tick = () => new Promise((r) => setImmediate(r))

// registerDiagnostics registers through ipc.handle; the handler is captured so it can be invoked
// while the router is still parked, which start() would otherwise drain.
function diagnosticsHandlerFor(ipc) {
  const handlers = new Map()
  registerDiagnostics({ ...ipc, handle: (type, fn) => handlers.set(type, fn) }, {
    health: createHealthMonitor(),
    getRoot: () => null,
  })
  return handlers.get('diagnostics:export')
}

test('the diagnostics bundle carries the router\'s own queue depth', async (t) => {
  await freshDurable(t)

  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: QUEUE_REQUESTS })
  ipc.handle('q:one', async () => null)
  const exportDiagnostics = diagnosticsHandlerFor(ipc)

  pipe.feed({ id: '1', type: 'q:one' })
  pipe.feed({ id: '2', type: 'q:one' })
  await tick()

  const parked = await exportDiagnostics({ redact: false })
  t.is(parked.health.queueDepth, 2, 'the parked frames reach the bundle, measured not hard-coded')
  t.is(typeof parked.health.inFlightRequests, 'number', 'and the in-flight count travels the same hop')

  ipc.start()
  await tick()

  const drained = await exportDiagnostics({ redact: false })
  t.is(drained.health.queueDepth, 0, 'the number follows the router rather than being sampled once')
})
