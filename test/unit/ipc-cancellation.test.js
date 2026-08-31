import test from 'brittle'
import { EventEmitter } from 'events'
import {
  createIPC, getInFlightCount, getRequestFailureCounters, resetRequestFailureCounters,
} from '../../src/shared/core/ipc.js'
import { throwIfAborted } from '../../src/shared/core/cancellation.js'
import { FRAME } from '../../src/shared/contract/frames.js'

// The router refuses names the contract does not declare, which is the point in production. A test
// declares the small vocabulary it exercises instead of registering into the real contract.
const TEST_REQUESTS = Object.freeze({
  ctx: { kind: 'query', args: {} },
  deaf: { kind: 'query', args: {} },
  slow: { kind: 'query', args: {} },
})

function fakePipe () {
  const ee = new EventEmitter()
  ee.written = []
  ee.write = (s) => { ee.written.push(s); return true }
  ee.feed = (obj) => ee.emit('data', Buffer.from(JSON.stringify(obj) + '\n'))
  ee.lastMsg = () => JSON.parse(ee.written[ee.written.length - 1])
  return ee
}
const tick = () => new Promise((r) => setImmediate(r))

test('the handler context carries the caller id and a live signal', async (t) => {
  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS })
  let seen = null
  ipc.handle('ctx', async (_msg, c) => { seen = c; return 1 })
  ipc.start()
  pipe.feed({ id: 42, type: 'ctx' })
  await tick()
  t.is(seen.id, 42, 'the id reaches the handler')
  t.ok(seen.signal, 'and the signal is a token, not null')
  t.is(seen.signal.aborted, false)
})

test('a cancel frame aborts an in-flight request', async (t) => {
  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS })
  let release
  ipc.handle('slow', async (_msg, { signal }) => {
    await new Promise((r) => { release = r })
    throwIfAborted(signal)
    return 'finished'
  })
  ipc.start()
  pipe.feed({ id: 7, type: 'slow' })
  await tick()
  t.is(getInFlightCount(), 1, 'registered while it runs')
  pipe.feed({ type: FRAME.CANCEL, id: 7 })
  await tick()
  release()
  await tick()
  t.is(pipe.lastMsg().code, 'ECANCELLED')
  t.is(pipe.lastMsg().id, 7)
  t.is(getInFlightCount(), 0, 'the registry is emptied by the settle, not by the abort')
})

test('a handler that ignores the signal still answers normally', async (t) => {
  // The property that makes a per-handler rollout safe: cancellation is advisory. A handler that
  // never learns about it is not broken by the router growing one.
  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS })
  let release
  ipc.handle('deaf', async () => { await new Promise((r) => { release = r }); return 'done anyway' })
  ipc.start()
  pipe.feed({ id: 8, type: 'deaf' })
  await tick()
  pipe.feed({ type: FRAME.CANCEL, id: 8 })
  await tick()
  release()
  await tick()
  t.is(pipe.lastMsg().data, 'done anyway', 'no hang, no error — the renderer has stopped listening')
  t.is(getInFlightCount(), 0)
})

test('cancelling a queued frame drops it and start() never runs it', async (t) => {
  // The case the control-frame decision exists for: during boot a cancel must not be queued behind
  // the very request it cancels.
  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS })
  let ran = 0
  ipc.handle('slow', async () => { ran++; return 1 })
  pipe.feed({ id: 3, type: 'slow' })
  pipe.feed({ type: FRAME.CANCEL, id: 3 })
  await tick()
  t.is(pipe.lastMsg().code, 'ECANCELLED', 'answered, because nothing else ever would')
  t.is(pipe.lastMsg().id, 3)
  ipc.start()
  await tick()
  t.is(ran, 0, 'the queued request never dispatched')
})

test('a cancel for an unknown, settled or twice-cancelled id is a silent no-op', async (t) => {
  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS })
  ipc.handle('ctx', async () => 1)
  ipc.start()
  pipe.feed({ type: FRAME.CANCEL, id: 999 })
  await tick()
  pipe.feed({ id: 1, type: 'ctx' })
  await tick()
  const after = pipe.written.length
  pipe.feed({ type: FRAME.CANCEL, id: 1 })
  pipe.feed({ type: FRAME.CANCEL, id: 1 })
  await tick()
  t.is(pipe.written.length, after, 'no response, no throw')
  t.is(getInFlightCount(), 0)
})

test('a cancel is not counted as a request', async (t) => {
  resetRequestFailureCounters()
  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS })
  ipc.start()
  pipe.feed({ type: FRAME.CANCEL, id: 5 })
  await tick()
  t.alike(getRequestFailureCounters(), {}, 'a control frame must not pollute the per-request instruments')
})

test('a frame with no id gets no token and cannot leak one', async (t) => {
  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS })
  let seen = 'unset'
  ipc.handle('ctx', async (_msg, c) => { seen = c.signal; return 1 })
  ipc.start()
  pipe.feed({ type: 'ctx' })
  await tick()
  t.is(seen, null, 'nothing can name it, so nothing can cancel it')
  t.is(getInFlightCount(), 0)
})

test('abortAll cancels every outstanding request', async (t) => {
  // What shutdown uses: a handler parked on a store that is about to close leaves through the
  // ECANCELLED path instead of throwing a "session closed" error into the crash backstop.
  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS })
  const seen = []
  ipc.handle('slow', async (_msg, { signal }) => {
    await new Promise((resolve) => { signal.onAbort(resolve) })
    seen.push(signal.reason?.code)
    throwIfAborted(signal)
  })
  ipc.start()
  pipe.feed({ id: 10, type: 'slow' })
  pipe.feed({ id: 11, type: 'slow' })
  await tick()
  t.is(getInFlightCount(), 2)
  t.is(ipc.abortAll('worker is shutting down'), 2)
  await tick()
  t.alike(seen, ['ECANCELLED', 'ECANCELLED'], 'both handlers were woken by the abort, not by a timer')
  t.is(getInFlightCount(), 0)
})

// The two vocabularies share one wire and are keyed by the same `type` field, so a name in both is
// ambiguous by construction: the reader's control-frame branch runs first and would silently shadow
// the declared request. This caught `shutdown` — which reads like a control frame and is in fact a
// real handler — being listed as one.
test('no control frame name is also a declared request', async (t) => {
  const { REQUEST_NAMES } = await import('../../src/shared/contract/requests.js')
  const { CONTROL_FRAMES } = await import('../../src/shared/contract/frames.js')
  const declared = new Set(REQUEST_NAMES)
  const both = CONTROL_FRAMES.filter((name) => declared.has(name))
  t.alike(both, [], 'a name belongs to the handler table or to the frame vocabulary, never both')
})

test('cancel works against the real contract, not just a test vocabulary', async (t) => {
  // The unit tests above declare their own small vocabulary, which cannot catch a mismatch with the
  // names production actually routes.
  const pipe = fakePipe()
  const ipc = createIPC(pipe)
  let release
  ipc.handle('share:list-files', async (_msg, { signal }) => {
    await new Promise((r) => { release = r })
    throwIfAborted(signal)
    return { entries: [] }
  })
  ipc.start()
  pipe.feed({ id: 21, type: 'share:list-files', spaceId: 'sp', shareId: 'sh', ownerKey: 'k' })
  await tick()
  t.is(getInFlightCount(), 1)
  pipe.feed({ type: FRAME.CANCEL, id: 21 })
  await tick()
  release()
  await tick()
  t.is(pipe.lastMsg().code, 'ECANCELLED', 'the request the renderer store actually cancels')
  t.is(getInFlightCount(), 0)
})
