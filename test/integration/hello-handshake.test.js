import test from 'brittle'
import { EventEmitter } from 'bare-events'
import { createIPC } from '../../src/shared/core/ipc.js'
import { helloFrame, sayHello } from '../helpers/ipc-hello.js'

// The handshake against a real router and real pipes: what a client is told on arrival, what it is
// replayed before it is told, and what happens to one that never introduces itself.
const REQUESTS = Object.freeze({ 'ping': { kind: 'query', args: {} } })

function pipe() {
  const ee = new EventEmitter()
  ee.written = []
  ee.write = (s) => { ee.written.push(s); return true }
  ee.send = (obj) => ee.emit('data', Buffer.from(JSON.stringify(obj) + '\n'))
  ee.frames = () => ee.written.map((l) => JSON.parse(l))
  ee.ack = () => ee.frames().filter((f) => f.type === 'hello-ack').at(-1)
  return ee
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test('an accepted hello is greeted with the stream it may resume from', async (t) => {
  const a = pipe()
  const ipc = createIPC(a, { requests: REQUESTS, epoch: 'e1' })
  a.send(helloFrame())
  const ack = a.ack()
  t.ok(ack.ok)
  t.is(ack.protocolVersion, 2)
  t.is(ack.trust, 'host', 'the spawn pipe is the host by construction')
  t.is(ack.epoch, 'e1')
  t.is(ack.head, ipc.head())
  t.is(ack.resume, null, 'a client with no cursor has nothing to catch up on')
})

test('a refused hello ends that client and leaves the one we have serving', async (t) => {
  const a = pipe()
  const b = pipe()
  const ipc = createIPC(a, { requests: REQUESTS, epoch: 'e1' })
  ipc.handle('ping', () => ({ pong: true }))
  a.send(helloFrame())
  ipc.attach(b)
  ipc.start()

  b.send({ ...helloFrame(), protocolVersion: 9999, protocolMin: 9999, protocolMax: 9999 })
  t.absent(b.ack().ok)
  t.is(b.ack().reason, 'we-are-older')
  t.is(ipc.clientCount(), 1, 'the refused client was shown the door')

  a.send({ id: 1, type: 'ping' })
  await tick()
  t.alike(a.frames().at(-1).data, { pong: true }, 'and the one we have is still answered')
})

test('a hello carrying a cursor is replayed before it is acked', async (t) => {
  const a = pipe()
  const ipc = createIPC(a, { requests: REQUESTS, epoch: 'e1' })
  a.send(helloFrame())
  ipc.start()
  for (let i = 1; i <= 4; i++) ipc.emit('event:network-status', { n: i })

  const b = pipe()
  ipc.attach(b)
  b.send(helloFrame({ cursor: { epoch: 'e1', since: 0 } }))
  const types = b.frames().map((f) => f.type)
  t.alike(types, ['event:network-status', 'event:network-status', 'event:network-status', 'event:network-status', 'hello-ack'],
    'every missed frame precedes the ack that describes them')
  t.is(b.ack().resume.replayed, 4)
  t.is(b.ack().resume.gap, false)
})

test('a cursor the ring can no longer answer for is told so rather than half-answered', async (t) => {
  const a = pipe()
  const ipc = createIPC(a, { requests: REQUESTS, epoch: 'e1', replay: { maxFrames: 4 } })
  a.send(helloFrame())
  ipc.start()
  for (let i = 1; i <= 20; i++) ipc.emit('event:network-status', { n: i })

  const b = pipe()
  ipc.attach(b)
  b.send(helloFrame({ cursor: { epoch: 'e1', since: 1 } }))
  t.is(b.ack().resume.gap, true)
  t.alike(b.frames().map((f) => f.type), ['hello-ack'], 'a partial catch-up would be worse than none')
})

test('a cursor from a previous generation is a gap whatever its number', async (t) => {
  const a = pipe()
  const ipc = createIPC(a, { requests: REQUESTS, epoch: 'e2' })
  a.send(helloFrame())
  ipc.start()
  ipc.emit('event:network-status', { n: 1 })

  const b = pipe()
  ipc.attach(b)
  b.send(helloFrame({ cursor: { epoch: 'an-older-worker', since: 1 } }))
  t.is(b.ack().resume.gap, true)
  t.is(b.ack().epoch, 'e2', 'and it is told which stream this actually is')
})

test('a client that never hellos is answered NOT_AUTHORIZED and consumes no in-flight slot', async (t) => {
  const a = pipe()
  const ipc = createIPC(a, { requests: REQUESTS, epoch: 'e1' })
  let ran = false
  ipc.handle('ping', () => { ran = true; return { pong: true } })
  ipc.start()

  a.send({ id: 1, type: 'ping' })
  await tick()
  t.is(a.frames().at(-1).code, 'NOT_AUTHORIZED')
  t.absent(ran, 'the handler never ran')
  t.is(ipc.inFlightCount(), 0)
})

// The helper takes the ack back off the record so a suite about requests is not asserting on the
// handshake. Only the ack: the frames an inline resume replays are the caller's to see, and a helper
// that spliced the whole window would hide them the day a hello carries a cursor.
test('the hello helper leaves the replayed frames where the client can see them', async (t) => {
  const a = pipe()
  const ipc = createIPC(a, { requests: REQUESTS, epoch: 'e1' })
  sayHello(a)
  ipc.start()
  for (let i = 1; i <= 3; i++) ipc.emit('event:network-status', { n: i })

  const b = pipe()
  ipc.attach(b)
  const ack = sayHello(b, { cursor: { epoch: 'e1', since: 0 } })
  t.is(ack.resume.replayed, 3, 'the ack came back')
  t.alike(b.frames().map((f) => f.type),
    ['event:network-status', 'event:network-status', 'event:network-status'],
    'and the replay it describes is still on the record, with only the ack removed')
})
