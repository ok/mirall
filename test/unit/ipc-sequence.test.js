import test from 'brittle'
import { EventEmitter } from 'events'
import { createIPC } from '../../src/shared/core/ipc.js'
import { EPHEMERAL_EVENTS, TARGETED_EVENTS, isEphemeralEvent } from '../../src/shared/contract/events.js'
import { MAIN_REQUEST_FRAME } from '../../src/shared/contract/main-requests.js'
import { sayHello } from '../helpers/ipc-hello.js'

const REQUESTS = Object.freeze({ 'ping': { kind: 'query', args: {} } })

function fakePipe() {
  const ee = new EventEmitter()
  ee.written = []
  ee.write = (s) => { ee.written.push(s); return true }
  ee.feed = (obj) => ee.emit('data', Buffer.from(JSON.stringify(obj) + '\n'))
  ee.frames = () => ee.written.map((l) => JSON.parse(l))
  ee.seqs = () => ee.frames().map((f) => f.seq)
  return ee
}

function router({ pipes = 1 } = {}) {
  const wires = Array.from({ length: pipes }, fakePipe)
  const ipc = createIPC(wires[0], { requests: REQUESTS, epoch: 'test-epoch' })
  const clients = [ipc.primary, ...wires.slice(1).map((p) => ipc.attach(p))]
  wires.forEach((wire) => sayHello(wire))
  ipc.start()
  return { ipc, wires, clients }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test('every pushed frame is numbered, and the numbers only go up', (t) => {
  const { ipc, wires, clients } = router()
  ipc.emit('event:files-updated', { spaceId: 's1' })
  ipc.emit('event:decoration', { path: '/a' })
  ipc.emit('event:leave-progress', { step: 1 }, { to: clients[0] })
  ipc.emit('event:network-status', {})
  const seqs = wires[0].seqs()
  // Five, not four: the files-updated poke also fans an event:reconcile, which is a pushed frame
  // like any other and takes its own number.
  t.is(seqs.length, 5, 'durable, ephemeral, targeted and the hint alike')
  t.alike(seqs, [...seqs].sort((a, b) => a - b))
  t.is(new Set(seqs).size, seqs.length, 'no number is used twice')
})

test('the hint bus rides the same counter', async (t) => {
  const { ipc, wires } = router()
  ipc.emit('event:files-updated', { spaceId: 's1' })
  const poke = wires[0].frames().find((f) => f.type === 'event:files-updated')
  // The coalescer's trailing edge lands on a timer; the leading edge is synchronous.
  const reconcile = wires[0].frames().find((f) => f.type === 'event:reconcile')
  t.ok(reconcile, 'the hint went out')
  t.ok(reconcile.seq > poke.seq, 'numbered by the same counter, not a second write site')
})

test('a main-request frame carries no ordinal and consumes none', (t) => {
  const { ipc, wires } = router()
  ipc.emit(MAIN_REQUEST_FRAME, { command: 'downloads:roots', args: { roots: [] } })
  ipc.emit('event:network-status', {})
  const [mainFrame, event] = wires[0].frames()
  t.absent('seq' in mainFrame, 'main consumes this off the same pipe; no client subscribes to it')
  t.is(event.seq, 1, 'so the first real event is still 1')
})

test('a response carries no ordinal', async (t) => {
  const { ipc, wires } = router()
  ipc.handle('ping', async () => ({ pong: true }))
  wires[0].feed({ id: 1, type: 'ping' })
  await tick()
  t.absent('seq' in wires[0].frames()[0], 'responses are correlated by id, not by position')
})

test('a payload cannot overwrite the ordinal', (t) => {
  const { ipc, wires } = router()
  ipc.emit('event:network-status', { seq: 999 })
  t.is(wires[0].frames()[0].seq, 1, 'the frame ordinal wins the spread')
})

test('ephemeral frames are numbered but not replayed', (t) => {
  const { ipc } = router()
  for (let i = 0; i < 5; i++) ipc.emit('event:decoration', { path: '/a', i })
  ipc.emit('event:files-updated', { spaceId: 's1' })

  // A client that joins now has missed everything before it, which is what makes it the one a
  // replay is for. The primary received all of it live and is owed nothing.
  const late = ipc.attach(fakePipe())
  const answer = ipc.resume(late, { epoch: ipc.epoch, since: 0 })
  t.is(answer.gap, false)
  // The durable poke, plus the reconcile hint it fanned. None of the five decorations.
  t.ok(answer.replayed >= 1 && answer.replayed <= 2, `replayed ${answer.replayed} durable frame(s), not the decorations`)
})

// REGRESSION (FIX-401-1: a resume replayed every frame after the cursor, including ones the client
// had just been sent live — it is on the broadcast list from the moment it attaches. Its pipe then
// carried an older ordinal after a newer one, which is precisely what a client using the sequence
// to deduplicate cannot survive.)
test('REGRESSION (FIX-401-1): a resume never re-sends what the client got live', (t) => {
  const { ipc } = router()
  ipc.emit('event:network-status', { n: 1 })

  const late = fakePipe()
  const client = ipc.attach(late)
  sayHello(late)
  ipc.emit('event:network-status', { n: 2 })
  ipc.emit('event:network-status', { n: 3 })

  const answer = ipc.resume(client, { epoch: ipc.epoch, since: 0 })
  t.is(answer.replayed, 1, 'only the frame from before it joined')
  t.alike(late.seqs(), [2, 3, 1], 'and its stream carries each ordinal exactly once')
})

test('a targeted frame is never replayed to anyone', (t) => {
  const { ipc, clients } = router({ pipes: 2 })
  ipc.emit('event:leave-progress', { step: 1 }, { to: clients[0] })
  t.is(ipc.resume(clients[1], { epoch: ipc.epoch, since: 0 }).replayed, 0,
    'one caller’s progress is not another’s to catch up on')
})

test('resume in range replays exactly what was missed, before it answers', (t) => {
  const { ipc } = router()
  ipc.emit('event:network-status', { n: 1 })
  ipc.emit('event:network-status', { n: 2 })
  ipc.emit('event:network-status', { n: 3 })

  // The reconnecting client: away since frame 1, back now.
  const back = fakePipe()
  const client = ipc.attach(back)
  sayHello(back)
  const answer = ipc.resume(client, { epoch: ipc.epoch, since: 1 })
  t.alike(answer, { epoch: 'test-epoch', head: 3, gap: false, replayed: 2 })
  t.alike(back.frames().map((f) => f.n), [2, 3], 'in order, and only the ones after the cursor')
})

test('a cursor the ring can no longer answer for is a gap', (t) => {
  const wires = [fakePipe()]
  const ipc = createIPC(wires[0], { requests: REQUESTS, epoch: 'test-epoch', replay: { maxFrames: 2 } })
  ipc.start()
  for (let n = 0; n < 5; n++) ipc.emit('event:network-status', { n })
  const back = fakePipe()
  const answer = ipc.resume(ipc.attach(back), { epoch: 'test-epoch', since: 1 })
  t.is(answer.gap, true)
  t.is(back.written.length, 0, 'nothing is written — a partial catch-up would be a lie')
})

test('a cursor ahead of the stream is a gap, not a silent no-op', (t) => {
  const { ipc } = router()
  ipc.emit('event:network-status', {})
  const answer = ipc.resume(ipc.attach(fakePipe()), { epoch: ipc.epoch, since: 999 })
  t.is(answer.gap, true, 'this worker never issued frame 999, so it cannot vouch for the gap')
})

test('a cursor from a previous worker is a gap', (t) => {
  const { ipc } = router()
  ipc.emit('event:network-status', {})
  const answer = ipc.resume(ipc.attach(fakePipe()), { epoch: 'an-older-worker', since: 0 })
  t.is(answer.gap, true, 'seq 40 means nothing across a restart')
  t.is(answer.epoch, 'test-epoch', 'and the client is told which stream this is')
})

test('a first-time subscriber has missed nothing', (t) => {
  const { ipc } = router()
  ipc.emit('event:network-status', {})
  t.alike(ipc.resume(ipc.attach(fakePipe()), {}), { epoch: 'test-epoch', head: 1, gap: false, replayed: 0 })
})

test('every targeted event is ephemeral, so none is ever replayed', (t) => {
  // The load-bearing direction: a per-caller frame must never be kept for someone else to receive.
  for (const name of TARGETED_EVENTS) {
    t.ok(isEphemeralEvent(name), `${name} is per-caller progress`)
    t.ok(EPHEMERAL_EVENTS.includes(name), `${name} is in the declared set`)
  }
})
