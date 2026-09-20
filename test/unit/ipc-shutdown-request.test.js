import test from 'brittle'
import { EventEmitter } from 'events'
import { createIPC } from '../../src/shared/core/ipc.js'
import { requireHost } from '../../src/shared/core/client-trust.js'

// A stop ends every client's session, so it is the host's call. Every client is the host until the
// worker listens on a socket, so this refuses nobody today — the point is that the rule exists
// before the first client it would refuse does.
const REQUESTS = Object.freeze({ 'shutdown': { kind: 'command', args: {} } })

function fakePipe() {
  const ee = new EventEmitter()
  ee.written = []
  ee.write = (s) => { ee.written.push(s); return true }
  ee.feed = (obj) => ee.emit('data', Buffer.from(JSON.stringify(obj) + '\n'))
  ee.frames = () => ee.written.map((l) => JSON.parse(l))
  return ee
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

// The shape worker/main.js registers, minus Bare.exit.
function router() {
  const host = fakePipe()
  const ipc = createIPC(host, { requests: REQUESTS })
  const stops = []
  ipc.handle('shutdown', (msg, ctx) => {
    requireHost(ctx.client)
    setTimeout(() => stops.push(ctx.client.id), 0)
    return { ok: true }
  })
  ipc.start()
  return { ipc, host, stops }
}

test('requireHost passes the host and refuses anyone else', (t) => {
  t.execution(() => requireHost({ trust: 'host' }))
  t.exception(() => requireHost({ trust: 'client' }), /only the host/)
  t.exception(() => requireHost(null))
})

test('the host is acknowledged BEFORE the teardown runs', async (t) => {
  const { host, stops } = router()
  host.feed({ id: 1, type: 'shutdown' })
  await tick()
  // The response is written in a promise continuation; the stop is a timer, which runs after
  // microtasks drain. That ordering is what lets a caller tell the stop landed.
  t.alike(host.frames(), [{ id: 1, type: 'response', data: { ok: true } }])
  await tick()
  t.alike(stops, [1], 'and only then does it begin')
})

test('a non-host client is refused and nothing stops', async (t) => {
  const { ipc, stops } = router()
  const other = fakePipe()
  ipc.attach(other, { trust: 'client' })
  other.feed({ id: 1, type: 'shutdown' })
  await tick()
  await tick()
  const [reply] = other.frames()
  t.is(reply.code, 'NOT_AUTHORIZED')
  t.alike(stops, [], 'the worker is still running')
})

test('an id-less shutdown frame still stops, and answers nobody', async (t) => {
  // Main sends { type: 'shutdown' } with no id from its quit sequence.
  const { host, stops } = router()
  host.feed({ type: 'shutdown' })
  await tick()
  await tick()
  t.alike(host.frames(), [], 'respond is a no-op without an id')
  t.alike(stops, [1], 'but the stop still happened')
})
