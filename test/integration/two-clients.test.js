import test from 'brittle'
import { EventEmitter } from 'bare-events'
import { createIPC } from '../../src/shared/core/ipc.js'
import { sayHello } from '../helpers/ipc-hello.js'

// The first test in the repo that drives the router with more than one client. Two in-process
// pipes stand in for two connections; what is under test is the routing, not the transport.
const REQUESTS = Object.freeze({
  'ping': { kind: 'query', args: {} },
  'slow': { kind: 'query', args: {} },
})

function pipe() {
  const ee = new EventEmitter()
  ee.written = []
  ee.write = (s) => { ee.written.push(s); return true }
  ee.send = (obj) => ee.emit('data', Buffer.from(JSON.stringify(obj) + '\n'))
  ee.frames = () => ee.written.map((l) => JSON.parse(l))
  return ee
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test('two clients interleave, and one cancelling leaves the other to finish', async (t) => {
  const a = pipe()
  const b = pipe()
  const ipc = createIPC(a, { requests: REQUESTS })
  sayHello(a)
  const pending = new Map()
  ipc.handle('slow', (msg, ctx) => new Promise((resolve) => {
    pending.set(ctx.client.id, () => resolve({ for: ctx.client.id }))
    ctx.signal.onAbort(() => resolve({ cancelled: ctx.client.id }))
  }))
  const clientB = ipc.attach(b)
  sayHello(b)
  ipc.start()

  a.send({ id: 1, type: 'slow' })
  b.send({ id: 1, type: 'slow' })
  await tick()
  t.is(ipc.inFlightCount(), 2, 'both are live under the same caller-minted id')

  a.send({ type: 'cancel', id: 1 })
  await tick()
  t.alike(a.frames(), [{ id: 1, type: 'response', data: { cancelled: 1 } }])
  t.is(b.written.length, 0, 'B is still working')

  pending.get(clientB.id)()
  await tick()
  t.alike(b.frames(), [{ id: 1, type: 'response', data: { for: 2 } }], 'and answers in full')
  t.is(ipc.inFlightCount(), 0, 'nothing leaks')
})

test('a client that disconnects mid-flight does not take the survivor with it', async (t) => {
  const a = pipe()
  const b = pipe()
  const ipc = createIPC(a, { requests: REQUESTS })
  sayHello(a)
  let releaseB = null
  ipc.handle('slow', (msg, ctx) => new Promise((resolve) => {
    if (ctx.client.id === 2) releaseB = () => resolve({ ok: true })
    ctx.signal.onAbort(() => resolve({ cancelled: true }))
  }))
  ipc.attach(b)
  sayHello(b)
  ipc.start()

  a.send({ id: 1, type: 'slow' })
  b.send({ id: 1, type: 'slow' })
  await tick()

  t.is(ipc.detach(ipc.primary), 1, 'the departing client had one request in flight')
  t.is(ipc.clientCount(), 1)

  releaseB()
  await tick()
  t.alike(b.frames(), [{ id: 1, type: 'response', data: { ok: true } }])
  t.is(ipc.inFlightCount(), 0)
})

test('a greeting runs once per client, with the router live', async (t) => {
  const a = pipe()
  const ipc = createIPC(a, { requests: REQUESTS })
  sayHello(a)
  ipc.onClientAttach((client) => { ipc.emit('event:worker-ready', {}, { to: client }) })
  const b = pipe()
  ipc.attach(b)
  sayHello(b)
  ipc.start()
  await tick()

  // By type, not by whole frame: every pushed frame carries an ordinal.
  for (const [name, wire] of [['A', a], ['B', b]]) {
    t.alike(wire.frames().map((f) => f.type), ['event:worker-ready'], `${name} was greeted exactly once`)
  }

  const c = pipe()
  ipc.attach(c)
  sayHello(c)
  await tick()
  t.alike(c.frames().map((f) => f.type), ['event:worker-ready'], 'and a client arriving later gets the same')
})
