import test from 'brittle'
import { EventEmitter } from 'events'
import { createIPC, getBootstrapPromise, scopeForEvent, getRequestFailureCounters, resetRequestFailureCounters } from '../../src/shared/core/ipc.js'
import { setRuntimeConfig } from '../../src/shared/core/runtime-config.js'

// The router is strict about names it does not know, which is the point in production. A test
// declares the small vocabulary it exercises instead of registering into the real contract.
const TEST_REQUESTS = Object.freeze({
  'add': { kind: 'command', args: {} },
  'boom': { kind: 'command', args: {} },
  'boom2': { kind: 'command', args: {} },
  'bootstrap': { kind: 'command', args: {} },
  'echo': { kind: 'command', args: {} },
  'ok': { kind: 'command', args: {} },
  'x': { kind: 'command', args: {} },
})


// Minimal pipe double: an EventEmitter that records what the IPC writes.
function fakePipe () {
  const ee = new EventEmitter()
  ee.written = []
  ee.write = (s) => { ee.written.push(s); return true }
  ee.feed = (obj) => ee.emit('data', Buffer.from(JSON.stringify(obj) + '\n'))
  ee.feedRaw = (str) => ee.emit('data', Buffer.from(str))
  ee.feedBytes = (buf) => ee.emit('data', buf)
  ee.lastMsg = () => JSON.parse(ee.written[ee.written.length - 1])
  return ee
}
const tick = () => new Promise((r) => setImmediate(r))

test('requests are queued until start(), then dispatched', async (t) => {
  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS })
  ipc.handle('add', (m) => m.a + m.b)
  pipe.feed({ id: '1', type: 'add', a: 2, b: 3 })
  await tick()
  t.is(pipe.written.length, 0, 'nothing written before start()')
  ipc.start()
  await tick()
  t.alike(pipe.lastMsg(), { id: '1', type: 'response', data: 5 })
})

test('NDJSON frame split across chunks reassembles', async (t) => {
  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS })
  ipc.handle('echo', (m) => m.v)
  ipc.start()
  const frame = JSON.stringify({ id: '9', type: 'echo', v: 'hi' }) + '\n'
  pipe.feedRaw(frame.slice(0, 6))
  pipe.feedRaw(frame.slice(6))
  await tick()
  t.is(pipe.lastMsg().data, 'hi')
})

// REGRESSION (FIX-H2-3: `buffer += chunk.toString()` decoded each chunk independently, so a chunk
// boundary inside a multi-byte character produced U+FFFD on both halves. U+FFFD is legal JSON, so
// the frame parsed cleanly and the handler ran on a corrupted string — a space name, a path, a
// memo, or the bootstrap frame's downloadFolder.)
test('REGRESSION (FIX-H2-3): a request frame split inside a multi-byte character reaches the handler intact', async (t) => {
  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS })
  ipc.handle('echo', (m) => m.v)
  ipc.start()

  const frame = Buffer.from(JSON.stringify({ id: '1', type: 'echo', v: 'Müller 项目 📁' }) + '\n')
  const cut = frame.indexOf(0xC3) + 1
  pipe.feedBytes(frame.subarray(0, cut))
  pipe.feedBytes(frame.subarray(cut))
  await tick()

  t.is(pipe.lastMsg().data, 'Müller 项目 📁', 'no replacement characters crossed the boundary')
})

// Not red before the fix — the old string reader also refused this one (measured). It guards the
// byte rewrite itself: the resync now walks bytes, and getting the frame boundary wrong there turns
// one oversized frame into one FORGED frame, which is worse than the bug being fixed.
test('the oversized-frame resync survives a split mid-character', async (t) => {
  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS, maxFrameBytes: 1024 })
  let calls = 0
  ipc.handle('echo', (m) => { calls++; return m.v })
  ipc.start()

  const oversized = Buffer.from('ü'.repeat(2048))
  pipe.feedBytes(oversized.subarray(0, 1025))
  pipe.feedBytes(oversized.subarray(1025))
  await tick()
  pipe.feedBytes(Buffer.from(JSON.stringify({ id: 'forged', type: 'echo', v: 1 }) + '\n'))
  await tick()
  t.is(calls, 0, 'the tail of a discarded frame is never dispatched')

  pipe.feed({ id: '2', type: 'echo', v: 'ü' })
  await tick()
  t.is(calls, 1, 'and the reader is live again afterwards')
  t.is(pipe.lastMsg().data, 'ü')
})

test('unknown command responds NOT_FOUND', async (t) => {
  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS })
  ipc.start()
  pipe.feed({ id: '7', type: 'nope' })
  await tick()
  const m = pipe.lastMsg()
  t.is(m.code, 'NOT_FOUND')
  t.is(m.id, '7')
})

test('handler rejection returns error + code (default UNKNOWN)', async (t) => {
  // Real handlers are async (`ipc.handle('x', async ...)`), so a throw becomes a
  // rejected promise that dispatch catches. (A *synchronous* throw from a
  // non-async handler escapes uncaught — all app handlers avoid that by being async.)
  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS })
  ipc.handle('boom', async () => { const e = new Error('kaboom'); e.code = 'MYCODE'; throw e })
  ipc.handle('boom2', async () => { throw new Error('no code') })
  ipc.start()
  pipe.feed({ id: 'a', type: 'boom' })
  await tick()
  t.is(pipe.lastMsg().error, 'kaboom')
  t.is(pipe.lastMsg().code, 'MYCODE')
  pipe.feed({ id: 'b', type: 'boom2' })
  await tick()
  t.is(pipe.lastMsg().code, 'UNKNOWN')
})

test('bootstrap line resolves getBootstrapPromise and is not dispatched', async (t) => {
  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS })
  let called = false
  ipc.handle('bootstrap', () => { called = true })
  ipc.start()
  pipe.feed({ type: 'bootstrap', storage: '/tmp/x', appVersion: '1' })
  const boot = await getBootstrapPromise()
  t.is(boot.storage, '/tmp/x')
  await tick()
  t.absent(called, 'bootstrap handler not invoked')
  t.is(pipe.written.length, 0, 'no response written for bootstrap')
})

test('emit writes {type, ...payload}; respond without id is a no-op', async (t) => {
  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS })
  ipc.emit('event:hello', { a: 1 })
  t.alike(pipe.lastMsg(), { type: 'event:hello', a: 1 })
  const before = pipe.written.length
  ipc.respond(undefined, { x: 1 })
  t.is(pipe.written.length, before, 'respond with no id wrote nothing')
})

test('malformed JSON is skipped, not fatal', async (t) => {
  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS })
  ipc.handle('ok', () => 'good')
  ipc.start()
  pipe.feedRaw('{ this is not json }\n')
  pipe.feed({ id: '1', type: 'ok' })
  await tick()
  t.is(pipe.lastMsg().data, 'good', 'recovered after bad line')
})

// --- verbose request/event tracing (drives window.mirall.verbose visibility) ---

// Count only the IPC logger's own lines (tagged [ipc]); forward the rest so
// brittle's own TAP over console.log is untouched.
// Both channels: the router logs its trace through console.log (debug) and its failures through
// console.warn, which is what makes a failed request visible at the default level.
function captureIpcLog (t) {
  const realLog = console.log
  const realWarn = console.warn
  const lines = []
  const grab = (real) => (...a) => { if (a[0] === '[ipc]') { lines.push(a.slice(1).join(' ')); return } real(...a) }
  console.log = grab(realLog)
  console.warn = grab(realWarn)
  t.teardown(() => { console.log = realLog; console.warn = realWarn; setRuntimeConfig({}) })
  return lines
}

test('dispatcher emits no [ipc] debug lines when verbose is off, still dispatches', async (t) => {
  const lines = captureIpcLog(t)
  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS })
  ipc.handle('echo', async (m) => m.v)
  ipc.start()
  setRuntimeConfig({ verbose: false })
  pipe.feed({ id: '1', type: 'echo', v: 'hi' })
  await tick()
  t.is(lines.length, 0, 'silent at debug level when verbose is off')
  t.is(pipe.lastMsg().data, 'hi', 'handler still ran and responded')
})

test('verbose traces req + res (with timing); response payload is unchanged', async (t) => {
  const lines = captureIpcLog(t)
  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS })
  ipc.handle('echo', async (m) => m.v)
  ipc.start()
  setRuntimeConfig({ verbose: true })
  pipe.feed({ id: '7', type: 'echo', v: 'yo' })
  await tick()
  t.ok(lines.includes('req echo #7'), 'logs the request with type + id')
  t.ok(lines.some((l) => l.startsWith('res echo #7 ok')), 'logs the response with ok + timing')
  t.is(pipe.lastMsg().data, 'yo', 'logging does not alter the response')
})

// Failures and unknown commands moved from debug to warn (FIX-OBS-1) so they survive the default
// level; this test keeps its original intent and follows them there.
test('logs handler errors and unknown commands', async (t) => {
  const lines = captureIpcLog(t)
  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS })
  ipc.handle('boom', async () => { throw new Error('kaboom') })
  ipc.start()
  setRuntimeConfig({ verbose: true })
  pipe.feed({ id: '2', type: 'boom' })
  pipe.feed({ id: '3', type: 'ghost' })
  await tick()
  const failed = lines.find((l) => l.startsWith('req-failed'))
  t.ok(failed, 'logs the failing handler')
  t.ok(failed.includes('req=boom'), 'with the request type as its own field')
  t.ok(failed.includes('id=2'), 'and the request id as its own field, not concatenated into the type')
  t.ok(failed.includes('kaboom'), 'and the error message')
  t.ok(lines.some((l) => l.startsWith('req-unknown ghost')), 'logs an unknown command')
  // ghost responds synchronously; boom's rejection resolves a tick later — so
  // find the #3 response rather than assuming write order.
  const ghost = pipe.written.map((s) => JSON.parse(s)).find((m) => m.id === '3')
  t.is(ghost.code, 'NOT_FOUND', 'unknown command still responds NOT_FOUND')
})

test('emit logs events but skips the noisy *-progress streams', (t) => {
  const lines = captureIpcLog(t)
  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS })
  setRuntimeConfig({ verbose: true })
  ipc.emit('event:files-updated', { spaceId: 'x' })
  ipc.emit('event:transfer-progress', { transferId: 't', bytes: 1 })
  t.ok(lines.includes('emit event:files-updated'), 'normal event is logged')
  t.absent(lines.some((l) => l.includes('progress')), 'a *-progress event is not logged')
  // A spaceId-scoped POKE fans out a coalesced reconcile hint next to the named event, so
  // files-updated writes twice; the progress stream writes once and is not a POKE.
  const msgs = pipe.written.map((s) => JSON.parse(s))
  t.is(pipe.written.length, 3, 'files-updated → named event + reconcile hint; progress → once')
  t.alike(msgs.find((m) => m.type === 'event:reconcile')?.scope, { kind: 'files', spaceId: 'x' },
    'the POKE fans out a files reconcile hint')
})

// --- POKE_SCOPE: every reconcile-driven view's poke sources ---

// REGRESSION (FIX-EDA-18: handshake/presence member transitions emitted event:members-updated but
// no Scope.members reconcile hint — a members view on the reconcile channel would never re-derive
// on a join, leave, avatar change, or silent-death lease expiry; same gap for shares/share-files).
test('REGRESSION (FIX-EDA-18): scopeForEvent maps every reconcile-driven poke source', (t) => {
  t.alike(scopeForEvent('event:files-updated', { spaceId: 'S1' }), { kind: 'files', spaceId: 'S1' })
  t.alike(scopeForEvent('event:shares-updated', { spaceId: 'S1' }), { kind: 'shares', spaceId: 'S1' })
  t.alike(scopeForEvent('event:share-files-updated', { spaceId: 'S1', shareId: 'A' }),
    { kind: 'share-files', spaceId: 'S1', shareId: 'A' })
  t.alike(scopeForEvent('event:members-updated', { spaceId: 'S1' }), { kind: 'members', spaceId: 'S1' })
  t.alike(scopeForEvent('event:member-left', { spaceId: 'S1' }), { kind: 'members', spaceId: 'S1' })
  t.alike(scopeForEvent('event:member-avatar-updated', { spaceId: 'S1' }), { kind: 'members', spaceId: 'S1' })
  t.alike(scopeForEvent('event:member-join-request', { spaceId: 'S1' }), { kind: 'join-requests', spaceId: 'S1' })
  t.alike(scopeForEvent('event:join-requests-updated', { spaceId: 'S1' }), { kind: 'join-requests', spaceId: 'S1' })
  t.alike(scopeForEvent('event:foreign-folder-mount-status', { spaceId: 'S1', shareId: 'A', status: 'active' }),
    { kind: 'shares', spaceId: 'S1' })
  t.alike(scopeForEvent('event:owned-folder-mount-status', { spaceId: 'S1', shareId: 'A', status: 'active' }),
    { kind: 'shares', spaceId: 'S1' })
})

test('scopeForEvent: a space-wide share-files poke is a wildcard on the share axis', (t) => {
  const scope = scopeForEvent('event:share-files-updated', { spaceId: 'S1' })
  t.is(scope.kind, 'share-files')
  t.is(scope.spaceId, 'S1')
  t.is(scope.shareId ?? null, null, 'absent shareId stays absent — scope-match treats it as a wildcard')
})

test('scopeForEvent: deliberately unmapped and malformed events fan no hint', (t) => {
  t.is(scopeForEvent('event:member-joined', { spaceId: 'S1' }), null,
    'member-joined fires pre-persist; members-updated is the post-persist poke')
  t.is(scopeForEvent('event:transfer-complete', { spaceId: 'S1' }), null)
  t.is(scopeForEvent('event:files-updated', {}), null, 'no spaceId → no hint')
  t.is(scopeForEvent('event:members-updated', {}), null, 'no spaceId → no hint')
})

test('emitting a members poke fans a members reconcile hint on the wire', (t) => {
  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS })
  ipc.emit('event:members-updated', { spaceId: 'S9' })
  const msgs = pipe.written.map((s) => JSON.parse(s))
  t.alike(msgs.find((m) => m.type === 'event:reconcile')?.scope, { kind: 'members', spaceId: 'S9' })
})

// --- read-buffer and pre-start queue bounds (r07-1) ---
//
// The caps are injectable for the same reason `requests` is: a test declares the small bound it
// exercises instead of allocating megabytes. One test below deliberately uses the REAL default,
// because a cap that is sane in a test and wrong in production is the failure worth guarding.

test('REGRESSION (FIX-IPC-CAP: an unterminated frame grew the read buffer without bound)', async (t) => {
  const pipe = fakePipe()
  resetRequestFailureCounters()
  t.teardown(() => resetRequestFailureCounters())
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS, maxFrameBytes: 1024 })
  ipc.handle('echo', (m) => m.v)
  ipc.start()

  // NO newline, ever. This is the whole defect: without a cap these bytes sit in `buffer` for the
  // life of the process and nothing observable happens — which is also why "no response was
  // written" does NOT prove the fix. The counter is the discriminator: it can only fire if the
  // reader refused the frame on SIZE, before any frame boundary arrived to parse.
  pipe.feedRaw('x'.repeat(4096))
  await tick()
  t.is(getRequestFailureCounters()['oversized-frame:INVALID_ARGUMENT'], 1,
    'the oversized frame was refused on size, with no newline to trigger a parse failure')
  t.is(pipe.written.length, 0, 'and it was not answered')

  pipe.feedRaw('\n')
  pipe.feed({ id: '1', type: 'echo', v: 42 })
  await tick()
  t.alike(pipe.lastMsg(), { id: '1', type: 'response', data: 42 }, 'the reader resynced and still serves')
})

test('REGRESSION (FIX-IPC-CAP: the tail of a discarded frame was parsed as a fresh frame)', async (t) => {
  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS, maxFrameBytes: 1024 })
  let calls = 0
  ipc.handle('echo', (m) => { calls++; return m.v })
  ipc.start()

  // An oversized frame whose TAIL is itself a valid request. Without a "still skipping" flag the
  // reader drops the head, then parses this tail and dispatches it — turning one oversized frame
  // into one forged frame, which is worse than the unbounded buffer it replaced.
  pipe.feedRaw('x'.repeat(2048))
  await tick()
  pipe.feedRaw(JSON.stringify({ id: 'forged', type: 'echo', v: 1 }) + '\n')
  await tick()
  t.is(calls, 0, 'the tail of a discarded frame is never dispatched')

  pipe.feed({ id: '2', type: 'echo', v: 7 })
  await tick()
  t.is(calls, 1, 'and the reader is live again afterwards')
})

test('a frame just under the REAL cap is delivered intact', async (t) => {
  const pipe = fakePipe()
  // The real default on purpose: the largest legitimate inbound frame is a profile update carrying
  // a base64 avatar (AVATAR_MAX_BYTES * 4/3 plus JSON escaping). A cap chosen too low — main's
  // 64 KB MAIN_REQUEST_MAX_LINE, say — would break avatar upload and no other test would notice.
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS })
  ipc.handle('echo', (m) => m.v.length)
  ipc.start()

  const big = 'a'.repeat(700_000)
  pipe.feed({ id: '1', type: 'echo', v: big })
  await tick()
  t.alike(pipe.lastMsg(), { id: '1', type: 'response', data: 700_000 })
})

test('many small frames arriving in one oversized chunk all dispatch', async (t) => {
  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS, maxFrameBytes: 1024 })
  let calls = 0
  ipc.handle('echo', () => { calls++; return null })
  ipc.start()

  // Twenty ~200-byte frames in ONE chunk, well past the 1 KB cap in total. Every frame is small;
  // only the read buffer is large. A cap that bounded the BUFFER rather than one FRAME would
  // discard all twenty.
  const one = JSON.stringify({ type: 'echo', v: 'b'.repeat(150) }) + '\n'
  pipe.feedRaw(one.repeat(20))
  await tick()
  t.is(calls, 20, 'the cap bounds one frame, not the read buffer')
})

test('a frame exactly at the cap is accepted, one byte over is refused', async (t) => {
  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS, maxFrameBytes: 200 })
  let calls = 0
  ipc.handle('echo', () => { calls++; return null })
  ipc.start()

  const exact = JSON.stringify({ type: 'echo', v: 'x'.repeat(200 - 30) })
  t.ok(exact.length <= 200, 'fixture is at or under the cap')
  pipe.feedRaw(exact + '\n')
  await tick()
  t.is(calls, 1, 'a frame at the cap is served')

  // Again the counter, not the absence of a reply: unparseable garbage produces no reply either way.
  resetRequestFailureCounters()
  pipe.feedRaw('y'.repeat(201))
  await tick()
  t.is(getRequestFailureCounters()['oversized-frame:INVALID_ARGUMENT'], 1, 'one byte over is refused on size')
  t.is(calls, 1, 'and no handler ran')
})

// REGRESSION (FIX-R7: the gate only fired while the buffer held NO newline, so whether a frame
// over the cap was refused depended on whether its terminator happened to land in the same chunk.
// A frame arriving whole was parsed and dispatched however large it was, and the bound the comment
// asserted — maxFrameBytes — was really maxFrameBytes plus one chunk.)
test('REGRESSION (FIX-R7): an oversized frame that arrives with its terminator is refused too', async (t) => {
  const pipe = fakePipe()
  resetRequestFailureCounters()
  t.teardown(() => resetRequestFailureCounters())
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS, maxFrameBytes: 1024 })
  let calls = 0
  ipc.handle('echo', () => { calls++; return null })
  ipc.start()

  // Complete — newline and all — in a single chunk, four times the cap.
  pipe.feedRaw(JSON.stringify({ id: 'big', type: 'echo', v: 'x'.repeat(4000) }) + '\n')
  await tick()
  t.is(calls, 0, 'the handler never ran')
  t.is(getRequestFailureCounters()['oversized-frame:INVALID_ARGUMENT'], 1, 'and it was refused on size')

  // The frames around it are unaffected: the cap bounds one frame, not the read buffer.
  pipe.feed({ id: '1', type: 'echo', v: 1 })
  await tick()
  t.is(calls, 1, 'a legal frame in the same stream still serves')
})

test('REGRESSION (FIX-IPC-CAP: the pre-start queue was unbounded)', async (t) => {
  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS, maxQueuedFrames: 10 })
  let calls = 0
  ipc.handle('echo', () => { calls++; return null })

  for (let i = 0; i < 25; i++) pipe.feed({ id: String(i), type: 'echo' })
  await tick()

  // Refused, not silently dropped: a caller awaiting a response must not hang forever on a
  // promise nothing will ever settle.
  const refusals = pipe.written.map((s) => JSON.parse(s)).filter((m) => m.code === 'INVALID_ARGUMENT')
  t.is(refusals.length, 15, 'every frame past the cap was answered with a refusal')

  ipc.start()
  await tick()
  t.is(calls, 10, 'exactly the capped number were queued and then dispatched')
})

test('the pre-start queue cap does not apply once started', async (t) => {
  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS, maxQueuedFrames: 2 })
  let calls = 0
  ipc.handle('echo', () => { calls++; return null })
  ipc.start()

  for (let i = 0; i < 20; i++) pipe.feed({ id: String(i), type: 'echo' })
  await tick()
  t.is(calls, 20, 'a live router dispatches without queueing')
})
