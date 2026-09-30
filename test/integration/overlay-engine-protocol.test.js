import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import Protomux from 'protomux'
import { makeProtocol } from '../helpers/overlay-engine.js'
import { makeDuplex } from './overlay-link-helpers.js'

// The protocol's fetchContent owns the per-contentHash scheduler: the cancel-before-
// scheduler window (#1b) and the same-hash join (#2). A minimal transfer stub is
// enough — fetchContent only hands it to the ChunkScheduler.
function fakeTransfer(overrides = {}) {
  return { startReceive() { return { received: new Set() } }, writeChunk() { return { ok: true } }, finalize() { return { ok: true } }, cancel() {}, pause() {}, ...overrides }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'p2-'))
const asker = () => ({ id: 'p', askedFor: new Set(), msgs: { contentRequest: { send() {} } } })

// A mux whose one channel records every send on any slot and lets the test fire its onopen.
function recordingMux() {
  const sends = []
  let channelOpts = null
  const mux = {
    createChannel(opts) {
      channelOpts = opts
      return { addMessage() { return { send: (m) => sends.push(m) } }, open() {}, close() {} }
    },
  }
  return { mux, sends, open: (hs) => channelOpts.onopen(hs) }
}

test('REGRESSION (MIR-53: _onOpen sends no syncState in mirall mode)', (t) => {
  const { mux, sends, open } = recordingMux()
  makeProtocol(fakeTransfer()).attach(mux)
  open({ version: 2, capabilities: 3 })
  t.is(sends.length, 0, 'the engine announces nothing on open')
})

test('#1b: cancelContent before the scheduler exists cancels the fetch at creation', async (t) => {
  const proto = makeProtocol(fakeTransfer())
  proto.cancelContent('zzz', { discardPartial: true }) // no scheduler yet → recorded in _cancelPending
  await t.exception(proto.fetchContent('zzz', [], { destPath: path.join(tmp(), 'z'), timeout: 200 }), /cancelled/,
    'fetchContent honors the pending cancel and rejects ECANCELLED — no requestContent sent')
})

test('#2: a concurrent same-hash fetch joins the in-flight one and copies the result', async (t) => {
  const proto = makeProtocol(fakeTransfer())
  const dir = tmp()
  const a = path.join(dir, 'a'); const b = path.join(dir, 'b')
  fs.writeFileSync(a, 'shared bytes') // the leader's assembled file

  const p = asker()
  const first = proto.fetchContent('abc', [p], { destPath: a, timeout: 200 })
  const second = proto.fetchContent('abc', [p], { destPath: b, timeout: 200 }) // joins (no 'already fetching' reject)
  t.is(proto.fetches.size, 1, 'the join did not create a second scheduler')

  // Drive the leader to completion: an empty chunk list finalizes immediately.
  proto.fetches.onChunkHashes(p, { path: 'content:abc', chunks: [] })
  await first
  await second
  t.is(fs.readFileSync(b).toString(), 'shared bytes', 'the joiner received a copy of the leader\'s verified bytes')
})

test('#1b: clearCancelPending drops a stale marker so the next same-hash fetch is not cancelled', async (t) => {
  const proto = makeProtocol(fakeTransfer())
  proto.cancelContent('ghi', { discardPartial: true }) // marks _cancelPending (no scheduler yet)
  proto.clearCancelPending('ghi')                       // fetchFile's no-peer abandon clears it
  const f = proto.fetchContent('ghi', [], { destPath: path.join(tmp(), 'g'), timeout: 200 })
  f.catch(() => {})
  t.is(proto.fetches.size, 1, 'a normal scheduler exists — the stale cancel did not fire')
})

test('#2: a joiner re-issues its own fetch when the leader was cancelled', async (t) => {
  const proto = makeProtocol(fakeTransfer())
  const dir = tmp()
  const first = proto.fetchContent('def', [], { destPath: path.join(dir, 'a'), timeout: 200 })
  first.catch(() => {})
  const second = proto.fetchContent('def', [], { destPath: path.join(dir, 'b'), timeout: 200 }) // joins
  second.catch(() => {})
  proto.cancelContent('def', { discardPartial: true }) // cancel the leader → ECANCELLED
  // The joiner's ECANCELLED handler re-issues, creating a fresh scheduler for the same hash.
  await new Promise((r) => setTimeout(r, 20))
  t.is(proto.fetches.size, 1, 'a fresh scheduler exists for the re-issued joiner (leader\'s was removed)')
})

test('a joiner re-issues its own fetch when the leader failed on its own destination', async (t) => {
  const notADir = () => { throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' }) }
  const proto = makeProtocol(fakeTransfer({ startReceive: notADir }))
  const p = asker()
  const leader = proto.fetchContent('ghi', [p], { destPath: '/leader/a', timeout: 200 })
  const joiner = proto.fetchContent('ghi', [p], { destPath: path.join(tmp(), 'b'), timeout: 200 })
  joiner.catch(() => {})
  const leaderSched = proto.fetches.get('ghi').sched
  proto.fetches.onChunkHashes(p, { path: 'content:ghi', chunks: [{ hash: 'h', length: 1 }] })
  await t.exception(leader, /not a directory/)
  await new Promise((r) => setTimeout(r, 20))
  t.is(proto.fetches.size, 1, 'the joiner runs its own scheduler instead of taking the leader\'s ENOTDIR')
  t.not(proto.fetches.get('ghi').sched, leaderSched, 'a fresh one, not the leader\'s')
})

test('a joiner shares the leader\'s integrity verdict', async (t) => {
  const mismatch = () => ({ ok: false, error: 'content-hash mismatch', code: 'EHASHMISMATCH' })
  const proto = makeProtocol(fakeTransfer({ finalize: mismatch }))
  const p = asker()
  const leader = proto.fetchContent('jkl', [p], { destPath: '/leader/a', timeout: 200 })
  leader.catch(() => {})
  const joiner = proto.fetchContent('jkl', [p], { destPath: path.join(tmp(), 'b') })
  proto.fetches.onChunkHashes(p, { path: 'content:jkl', chunks: [] })
  await t.exception(joiner, /mismatch/)
})

// ── transfer-control (message 12): downloader→holder pause/stop signal ─────────

// Transfer frames about a hash go only to a peer we sent a content-request for it (askedFor).
function fakePeer(sent, asked = ['abc']) {
  return { msgs: { transferControl: { send: (m) => sent.push(m) } }, authorizedServe: new Map(), askedFor: new Set(asked) }
}

// cancelContent only signals when a scheduler exists (an active fetch); seed one.
function seedScheduler(proto, contentHash) {
  proto.fetches.adoptForTests(contentHash, { destPath: '/x', cancel() {} })
}

test('REGRESSION (FIX-1): cancelContent pause broadcasts transferControl PAUSED', (t) => {
  const proto = makeProtocol(fakeTransfer())
  const sent = []
  proto.channel.adoptForTests({}, fakePeer(sent))
  seedScheduler(proto, 'abc')
  proto.cancelContent('abc', { discardPartial: false })
  t.alike(sent, [{ contentHash: 'abc', state: 0 }], 'one PAUSED (state 0) sent before local teardown')
})

test('REGRESSION (FIX-2): cancelContent stop broadcasts transferControl STOPPED', (t) => {
  const proto = makeProtocol(fakeTransfer())
  const sent = []
  proto.channel.adoptForTests({}, fakePeer(sent))
  seedScheduler(proto, 'abc')
  proto.cancelContent('abc', { discardPartial: true })
  t.alike(sent, [{ contentHash: 'abc', state: 1 }], 'one STOPPED (state 1) sent before local teardown')
})

test('cancelContent with signal:false (supersede) sends nothing', (t) => {
  const proto = makeProtocol(fakeTransfer())
  const sent = []
  proto.channel.adoptForTests({}, fakePeer(sent))
  seedScheduler(proto, 'abc')
  proto.cancelContent('abc', { discardPartial: true, signal: false })
  t.is(sent.length, 0, 'a supersede restart suppresses the transfer-control broadcast')
})

test('cancelContent without a scheduler (pre-fetch cancel) sends nothing', (t) => {
  const proto = makeProtocol(fakeTransfer())
  const sent = []
  proto.channel.adoptForTests({}, fakePeer(sent))
  proto.cancelContent('abc', { discardPartial: false }) // no scheduler → _cancelPending path
  t.is(sent.length, 0, 'no holder authorized us yet, so nothing is broadcast')
})

test('sendStopControl broadcasts STOPPED without a scheduler (discard-after-pause path)', (t) => {
  const proto = makeProtocol(fakeTransfer())
  const sent = []
  proto.channel.adoptForTests({}, fakePeer(sent))
  proto.sendStopControl('abc')
  t.alike(sent, [{ contentHash: 'abc', state: 1 }], 'STOPPED sent directly, no scheduler required')
  proto.sendStopControl('abc')
  t.is(sent.length, 1, 'a stopped hash is forgotten, so the holder is not told twice')
})

test('REGRESSION (MIR-67: transfer frames skip a peer never asked for the hash)', (t) => {
  const proto = makeProtocol(fakeTransfer())
  const asked = []
  const other = []
  proto.channel.adoptForTests({}, { ...fakePeer(asked), msgs: { transferControl: { send: (m) => asked.push(m) }, transferProgress: { send: (m) => asked.push(m) } } })
  proto.channel.adoptForTests({}, { ...fakePeer(other, []), msgs: { transferControl: { send: (m) => other.push(m) }, transferProgress: { send: (m) => other.push(m) } } })
  seedScheduler(proto, 'abc')
  proto.fetches.sendProgress('abc', 700)
  proto.cancelContent('abc', { discardPartial: false })
  t.is(asked.length, 2, 'the asked holder got the progress and the pause')
  t.is(other.length, 0, 'the unasked peer got nothing')
})

// The authorizedServe VALUE is a grant record — { from, epoch } — not a bare `from`. The epoch is
// what lets a membership change invalidate a grant that was cached at request time; every reader
// must go through .from. These two tests are the guard on that shape.
test('transferControl maps to onServeControl using the authenticated authorizedServe identity', (t) => {
  const calls = []
  const proto = makeProtocol(fakeTransfer(), { onServeControl: (info) => calls.push(info) })
  const peer = { authorizedServe: new Map([['content:abc', { from: 'peerProfileKey', epoch: 0 }]]) }
  proto.serve.onTransferControl(peer, { contentHash: 'abc', state: 1 })
  proto.serve.onTransferControl(peer, { contentHash: 'abc', state: 0 })
  t.is(calls.length, 2)
  t.alike(calls[0], { path: 'content:abc', peer, from: 'peerProfileKey', state: 'stopped' })
  t.alike(calls[1], { path: 'content:abc', peer, from: 'peerProfileKey', state: 'paused' })
})

test('transferControl is a no-op for a hash the peer was never authorized to fetch (anti-spoof)', (t) => {
  const calls = []
  const proto = makeProtocol(fakeTransfer(), { onServeControl: (info) => calls.push(info) })
  proto.serve.onTransferControl({ authorizedServe: new Map() }, { contentHash: 'zzz', state: 1 })
  t.is(calls.length, 0, 'no ledger callback without an authenticated serve record')
})

test('cancelContent tolerates a peer that predates slot 12 (no throw)', (t) => {
  const proto = makeProtocol(fakeTransfer())
  proto.channel.adoptForTests({}, { msgs: {}, authorizedServe: new Map(), askedFor: new Set(['abc']) }) // old peer: no transferControl slot
  seedScheduler(proto, 'abc')
  try { proto.cancelContent('abc', { discardPartial: false }); t.pass('cancelContent did not throw') }
  catch (err) { t.fail('threw: ' + err.message) }
})

// ── transfer-progress (message 13): downloader→holder resume have-baseline ──────

test('sendProgress broadcasts the have-baseline to every connected holder', (t) => {
  const proto = makeProtocol(fakeTransfer())
  const sent = []
  proto.channel.adoptForTests({}, { msgs: { transferProgress: { send: (m) => sent.push(m) } }, authorizedServe: new Map(), askedFor: new Set(['abc']) })
  proto.fetches.sendProgress('abc', 700)
  t.alike(sent, [{ contentHash: 'abc', have: 700 }], 'have-baseline broadcast to the holder')
})

test('transferProgress maps to onServeProgress using the authenticated authorizedServe identity', (t) => {
  const calls = []
  const proto = makeProtocol(fakeTransfer(), { onServeProgress: (info) => calls.push(info) })
  const peer = { authorizedServe: new Map([['content:abc', { from: 'peerProfileKey', epoch: 0 }]]) }
  proto.serve.onTransferProgress(peer, { contentHash: 'abc', have: 700 })
  t.is(calls.length, 1)
  t.alike(calls[0], { path: 'content:abc', peer, from: 'peerProfileKey', have: 700 })
})

test('transferProgress is a no-op for a hash the peer was never authorized to fetch (anti-spoof)', (t) => {
  const calls = []
  const proto = makeProtocol(fakeTransfer(), { onServeProgress: (info) => calls.push(info) })
  proto.serve.onTransferProgress({ authorizedServe: new Map() }, { contentHash: 'zzz', have: 700 })
  t.is(calls.length, 0, 'no ledger callback without an authenticated serve record')
})

test('sendProgress tolerates a peer that predates slot 13 (no throw)', (t) => {
  const proto = makeProtocol(fakeTransfer())
  proto.channel.adoptForTests({}, { msgs: {}, authorizedServe: new Map(), askedFor: new Set(['abc']) }) // old peer: no transferProgress slot
  try { proto.fetches.sendProgress('abc', 700); t.pass('sendProgress did not throw') }
  catch (err) { t.fail('threw: ' + err.message) }
})

// A handler's failure ends at the dispatch: the channel stays open and keeps routing, and the
// rejection reaches neither protomux nor the process's unhandled-rejection backstop.
test('a rejecting slot handler leaves the channel open', async (t) => {
  const [x, y] = makeDuplex()
  const asking = makeProtocol(fakeTransfer())
  const serving = makeProtocol(fakeTransfer())
  const askingPeer = asking.attach(Protomux.from(x))
  const servingPeer = serving.attach(Protomux.from(y))
  let calls = 0
  serving.serve.onContentRequest = async () => { calls++; throw new Error('handler failed') }
  const unhandled = []
  const onUnhandled = (err) => unhandled.push(err)
  Bare.on('unhandledRejection', onUnhandled)
  t.teardown(() => { Bare.off('unhandledRejection', onUnhandled); asking.destroy(); serving.destroy() })
  await new Promise((r) => setTimeout(r, 50))
  askingPeer.msgs.contentRequest.send({ contentHash: 'ab'.repeat(32), from: '' })
  await new Promise((r) => setTimeout(r, 50))
  askingPeer.msgs.contentRequest.send({ contentHash: 'cd'.repeat(32), from: '' })
  await new Promise((r) => setTimeout(r, 50))
  t.is(calls, 2, 'the second frame still reached the handler')
  t.absent(servingPeer.channel.closed, 'the serving channel is still open')
  t.absent(askingPeer.channel.closed, 'and so is the asking one')
  t.is(unhandled.length, 0, 'the rejection is contained at the dispatch')
})
