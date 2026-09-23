import test from 'brittle'
import { EventEmitter } from 'bare-events'
import { createIPC } from '../../src/shared/core/ipc.js'
import { sayHello } from '../helpers/ipc-hello.js'

// A reconnect across a real transfer. The point of the ephemeral rule is here: without it the
// decoration burst evicts every durable frame from the ring and this reports a gap.
const REQUESTS = Object.freeze({ 'ping': { kind: 'query', args: {} } })

function pipe() {
  const ee = new EventEmitter()
  ee.written = []
  ee.write = (s) => { ee.written.push(s); return true }
  ee.frames = () => ee.written.map((l) => JSON.parse(l))
  ee.events = (type) => ee.frames().filter((f) => f.type === type)
  return ee
}

test('a client that was away is caught up across a transfer’s worth of chatter', async (t) => {
  const a = pipe()
  const ipc = createIPC(a, { requests: REQUESTS, epoch: 'e1' })
  sayHello(a)
  ipc.start()

  ipc.emit('event:network-status', { n: 1 })
  const cursor = a.frames().at(-1).seq

  // A transfer: thousands of per-chunk frames, interleaved with the durable ones that matter.
  for (let i = 0; i < 2000; i++) ipc.emit('event:decoration', { path: '/big.bin', i })
  ipc.emit('event:transfer-complete', { transferId: 't1' })
  for (let i = 0; i < 2000; i++) ipc.emit('event:decoration', { path: '/big.bin', i })
  ipc.emit('event:transfer-complete', { transferId: 't2' })

  // The client drops and comes back as a new connection, carrying only its cursor.
  ipc.detach(ipc.primary)
  const b = pipe()
  const reconnected = ipc.attach(b)
  sayHello(b)

  const answer = ipc.resume(reconnected, { epoch: 'e1', since: cursor })
  t.is(answer.gap, false, '4000 decoration frames did not evict what mattered')
  t.alike(b.events('event:transfer-complete').map((f) => f.transferId), ['t1', 't2'],
    'both durable frames, in order')
  t.is(b.events('event:decoration').length, 0, 'and none of the chatter')
})

test('a client away too long is told to resync rather than half-answered', async (t) => {
  const a = pipe()
  const ipc = createIPC(a, { requests: REQUESTS, epoch: 'e1', replay: { maxFrames: 8 } })
  sayHello(a)
  ipc.start()
  ipc.emit('event:network-status', { n: 0 })
  const cursor = a.frames().at(-1).seq
  for (let i = 1; i <= 50; i++) ipc.emit('event:network-status', { n: i })

  const before = a.written.length
  const answer = ipc.resume(ipc.primary, { epoch: 'e1', since: cursor })
  t.is(answer.gap, true)
  t.is(a.written.length, before, 'nothing replayed — a partial catch-up would be worse than none')
  t.is(answer.head, 51, 'but it learns where the stream is now')
})

test('a client that never left is owed nothing, and its stream stays ordered', async (t) => {
  const a = pipe()
  const b = pipe()
  const ipc = createIPC(a, { requests: REQUESTS, epoch: 'e1' })
  sayHello(a)
  const second = ipc.attach(b)
  sayHello(b)
  ipc.start()

  ipc.emit('event:network-status', { n: 1 })
  // A client is on the broadcast list from the moment it attaches, so it already has frame 1.
  // Replaying it would put an older ordinal after a newer one on a pipe that is otherwise ordered.
  const answer = ipc.resume(second, { epoch: 'e1', since: 0 })
  ipc.emit('event:network-status', { n: 2 })

  t.is(answer.replayed, 0, 'nothing was missed, so nothing is re-sent')
  t.alike(a.frames().map((f) => f.seq), [1, 2])
  t.alike(b.frames().map((f) => f.seq), [1, 2], 'each ordinal exactly once, in order')
})

// REGRESSION (FIX-RESUME-ATTACH: the replay was bounded by when the client's SOCKET attached. The
// consumer need not be the socket — the renderer asks over main's pipe, which attaches before the
// first frame and stays up for the worker's whole life — so that bound discarded every line and the
// asker was told it was caught up, whatever it had missed.)
test('REGRESSION (FIX-RESUME-ATTACH: a requested resume is bounded by the cursor, not by the attach)', async (t) => {
  const a = pipe()
  const ipc = createIPC(a, { requests: REQUESTS, epoch: 'e1' })
  sayHello(a)
  ipc.start()
  t.is(ipc.primary.attachedAt, 0, 'the spawn pipe attached before the first frame')

  ipc.emit('event:network-status', { n: 1 })
  ipc.emit('event:transfer-complete', { transferId: 't1' })
  const before = a.written.length

  const answer = ipc.resume(ipc.primary, { epoch: 'e1', since: 0 }, { sinceAttach: false })
  t.is(answer.gap, false)
  t.is(answer.replayed, 2, 'both durable frames were re-sent to the client that asked')
  t.alike(a.written.slice(before).map((l) => JSON.parse(l).seq), [1, 2], 'in order')

  const caughtUp = ipc.resume(ipc.primary, { epoch: 'e1', since: answer.head }, { sinceAttach: false })
  t.is(caughtUp.replayed, 0, 'and a cursor at the head is owed nothing')
})
