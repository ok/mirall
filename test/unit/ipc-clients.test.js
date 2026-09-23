import test from 'brittle'
import { EventEmitter } from 'events'
import { createIPC } from '../../src/shared/core/ipc.js'
import { IPC_PROTOCOL_VERSION } from '../../src/shared/contract/ipc-frames.js'
import { sayHello } from '../helpers/ipc-hello.js'
import { requireHost } from '../../src/shared/core/client-trust.js'

// A router with N pipes behind it. The first is the one createIPC was built with — the single
// client every other test in the suite models — and the rest are attached the way a daemon would
// accept them.
const TEST_REQUESTS = Object.freeze({
  'files:list': { kind: 'query', args: {} },
  'ping': { kind: 'query', args: {} },
  'shutdown': { kind: 'command', args: {} },
  'slow': { kind: 'query', args: {} },
})

function fakePipe() {
  const ee = new EventEmitter()
  ee.written = []
  ee.write = (s) => { ee.written.push(s); return true }
  ee.feed = (obj) => ee.emit('data', Buffer.from(JSON.stringify(obj) + '\n'))
  ee.feedRaw = (str) => ee.emit('data', Buffer.from(str))
  ee.frames = () => ee.written.map((l) => JSON.parse(l))
  ee.of = (type) => ee.frames().filter((f) => f.type === type)
  return ee
}

function router({ handlers = {}, pipes = 2, start = true } = {}) {
  const wires = Array.from({ length: pipes }, fakePipe)
  const ipc = createIPC(wires[0], { requests: TEST_REQUESTS })
  for (const [name, fn] of Object.entries(handlers)) ipc.handle(name, fn)
  const clients = [ipc.primary, ...wires.slice(1).map((p) => ipc.attach(p))]
  wires.forEach((wire) => sayHello(wire))
  if (start) ipc.start()
  return { ipc, wires, clients }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const hang = () => new Promise(() => {})

test('REGRESSION (FIX-402-1): two clients may hold the same request id', async (t) => {
  // Ids are minted per caller and every caller starts at 1, so "request 7" names two different
  // pieces of work. One router-wide map made A's cancel abort B's.
  const signals = new Map()
  const { ipc, wires } = router({
    handlers: { 'files:list': (msg, ctx) => { signals.set(ctx.client.id, ctx.signal); return hang() } },
  })
  wires[0].feed({ id: 7, type: 'files:list' })
  wires[1].feed({ id: 7, type: 'files:list' })
  await tick()
  t.alike([...signals.keys()], [1, 2], 'both dispatched, each knowing who asked')
  t.is(ipc.inFlightCount(), 2)

  wires[0].feed({ type: 'cancel', id: 7 })
  await tick()
  t.ok(signals.get(1).aborted, "A's own request 7 is cancelled")
  t.absent(signals.get(2).aborted, "B's request 7 is untouched")
  t.is(wires[1].of('response').length, 0, 'and B was not answered')
})

test('a response reaches only the client that asked', async (t) => {
  const { wires } = router({ handlers: { ping: async () => ({ pong: true }) } })
  wires[1].feed({ id: 3, type: 'ping' })
  await tick()
  t.is(wires[0].written.length, 0, 'the other client saw nothing')
  t.alike(wires[1].frames()[0], { id: 3, type: 'response', data: { pong: true } })
})

test('a broadcast reaches every client', (t) => {
  const { ipc, wires } = router()
  ipc.emit('event:files-updated', { spaceId: 's1' })
  t.is(wires[0].of('event:files-updated').length, 1)
  t.is(wires[1].of('event:files-updated').length, 1)
})

test('a targeted event reaches one client, by object or by id', (t) => {
  const { ipc, wires, clients } = router()
  ipc.emit('event:leave-progress', { step: 1 }, { to: clients[1] })
  t.is(wires[0].of('event:leave-progress').length, 0)
  t.is(wires[1].of('event:leave-progress').length, 1, 'by object')

  ipc.emit('event:leave-progress', { step: 2 }, { to: clients[0].id })
  t.is(wires[0].of('event:leave-progress').length, 1, 'by id')
})

test('a targeted event with no target is dropped, never broadcast', (t) => {
  const { ipc, wires } = router()
  ipc.emit('event:leave-progress', { step: 1 })
  t.is(wires[0].written.length, 0)
  t.is(wires[1].written.length, 0, 'one caller’s progress never lands in another’s UI')
})

test('a targeted event to a client that has gone is a silent no-op', (t) => {
  const { ipc, clients } = router()
  ipc.detach(clients[1])
  t.execution(() => ipc.emit('event:leave-progress', { step: 1 }, { to: clients[1] }),
    'the teardown outlives its client, and says so to nobody')
})

test('a targeted event fans no reconcile hint', (t) => {
  const { ipc, wires, clients } = router()
  // files-updated is a poke: broadcast it and the hint bus fans event:reconcile behind it.
  ipc.emit('event:files-updated', { spaceId: 's1' }, { to: clients[0] })
  t.is(wires[0].of('event:reconcile').length, 0, 'a targeted frame says nothing about shared state')
})

test('a client attached after start() is greeted; one attached before is greeted at start()', async (t) => {
  const greeted = []
  const wires = [fakePipe(), fakePipe()]
  const ipc = createIPC(wires[0], { requests: TEST_REQUESTS })
  ipc.onClientAttach((client) => { greeted.push(client.id) })
  const early = ipc.attach(wires[1])
  t.alike(greeted, [], 'nothing is true to say before the router is live')

  ipc.start()
  await tick()
  t.alike(greeted.sort(), [1, 2], 'everyone attached by start() is greeted once')

  ipc.attach(fakePipe())
  await tick()
  t.alike(greeted.sort(), [1, 2, 3], 'and a late client is greeted on arrival')
  t.ok(early)
})

test('a greeting that rejects is logged, not thrown', async (t) => {
  const { ipc } = router({ pipes: 1 })
  ipc.onClientAttach(async () => { throw new Error('greeting blew up') })
  t.execution(() => ipc.attach(fakePipe()))
  await tick()
})

test('detach aborts the departing client’s work and only that', async (t) => {
  const aborted = []
  const { ipc, wires, clients } = router({
    handlers: { 'files:list': (msg, ctx) => new Promise(() => { ctx.signal.onAbort(() => aborted.push(ctx.client.id)) }) },
  })
  wires[0].feed({ id: 1, type: 'files:list' })
  wires[1].feed({ id: 1, type: 'files:list' })
  await tick()

  t.is(ipc.detach(clients[0]), 1, 'one request was in flight for the departing client')
  t.alike(aborted, [1])
  t.is(ipc.inFlightCount(), 1, 'the survivor keeps its own')
  t.is(ipc.clientCount(), 1)
})

test('detaching twice is a no-op', (t) => {
  const { ipc, clients } = router()
  ipc.detach(clients[1])
  t.is(ipc.detach(clients[1]), 0, 'nothing left to abort, no second round of hooks')
})

test('disconnect hooks each fire once, and a throwing one does not starve the next', (t) => {
  const calls = []
  const { ipc, clients } = router()
  ipc.onClientDisconnect(() => { calls.push('first'); throw new Error('hook blew up') })
  ipc.onClientDisconnect((client) => { calls.push('second:' + client.id) })
  ipc.detach(clients[1])
  t.alike(calls, ['first', 'second:2'])
})

test('an unsubscribed disconnect hook stops firing', (t) => {
  const calls = []
  const { ipc, clients } = router()
  const off = ipc.onClientDisconnect(() => calls.push('x'))
  off()
  ipc.detach(clients[1])
  t.alike(calls, [])
})

test('abortAll still reaches every client', async (t) => {
  const aborted = []
  const { ipc, wires } = router({
    handlers: { 'files:list': (msg, ctx) => new Promise(() => { ctx.signal.onAbort(() => aborted.push(ctx.client.id)) }) },
  })
  wires[0].feed({ id: 1, type: 'files:list' })
  wires[1].feed({ id: 2, type: 'files:list' })
  await tick()
  t.is(ipc.abortAll('shutting down'), 2)
  t.alike(aborted.sort(), [1, 2])
})

test('the pre-start queue is per client', async (t) => {
  const ran = []
  const { ipc, wires } = router({
    handlers: { 'files:list': (msg, ctx) => { ran.push(ctx.client.id); return { ok: true } } },
    start: false,
  })
  wires[0].feed({ id: 5, type: 'files:list' })
  wires[1].feed({ id: 5, type: 'files:list' })
  t.is(ipc.queueDepth(), 2)

  wires[0].feed({ type: 'cancel', id: 5 })
  t.is(ipc.queueDepth(), 1, "only A's frame was dropped")

  ipc.start()
  await tick()
  t.alike(ran, [2], "B's identically-numbered frame still ran")
})

test('detach drops the client’s queued frames without answering them', (t) => {
  const { ipc, wires, clients } = router({ start: false })
  wires[1].feed({ id: 9, type: 'files:list' })
  t.is(ipc.queueDepth(), 1)
  ipc.detach(clients[1])
  t.is(ipc.queueDepth(), 0)
  t.is(wires[1].written.length, 0, 'there is nobody left to refuse')
})

test('two clients’ partial frames do not splice', async (t) => {
  const seen = []
  const { ipc, wires } = router({ handlers: { 'files:list': (msg, ctx) => { seen.push([ctx.client.id, msg.id]); return { ok: true } } } })
  wires[0].feedRaw('{"id":1,"type":"fil')
  wires[1].feedRaw('{"id":2,"type":"files:list"}\n')
  wires[0].feedRaw('es:list"}\n')
  await tick()
  t.alike(seen, [[2, 2], [1, 1]], 'each client’s reader holds its own half-frame')
  t.ok(ipc)
})

test('a bootstrap frame from a non-primary client is ignored', async (t) => {
  const { ipc, wires } = router()
  wires[1].feed({ type: 'bootstrap', storage: '/impostor', protocolVersion: IPC_PROTOCOL_VERSION })
  await tick()
  wires[0].feed({ type: 'bootstrap', storage: '/real', protocolVersion: IPC_PROTOCOL_VERSION })
  t.is((await ipc.bootstrapPromise).storage, '/real',
    'the frame carries the identity KEK — a later client must not be able to settle boot')
})

test('the handler context names the client that asked', async (t) => {
  let ctxSeen = null
  const { wires } = router({ handlers: { ping: (msg, ctx) => { ctxSeen = ctx; return { ok: true } } } })
  wires[1].feed({ id: 4, type: 'ping' })
  await tick()
  t.is(ctxSeen.client.id, 2)
  t.is(ctxSeen.client.trust, 'peer', 'a client that is not the spawn pipe gets the lesser authority')
  t.is(ctxSeen.id, 4)
})

// Trust is assigned from the transport, so the default has to be the lesser authority: an attach
// that says nothing about itself must not be able to stop the worker every other client is using.
test('a client that is not the spawn pipe cannot stop the worker', async (t) => {
  const { wires } = router({ handlers: { shutdown: (msg, ctx) => { requireHost(ctx.client); return { ok: true } } } })
  wires[1].feed({ id: 9, type: 'shutdown' })
  await tick()
  t.is(wires[1].frames().at(-1).code, 'NOT_AUTHORIZED')
  wires[0].feed({ id: 9, type: 'shutdown' })
  await tick()
  t.alike(wires[0].frames().at(-1).data, { ok: true }, 'while the spawn pipe still may')
})
