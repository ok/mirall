import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { OverlayProtocolV2 } from '../../src/shared/transfer/backends/overlay/vendor/protocol-v2.js'

// The protocol's fetchContent owns the per-contentHash scheduler: the cancel-before-
// scheduler window (#1b) and the same-hash join (#2). A minimal transfer stub is
// enough — fetchContent only hands it to the ChunkScheduler.
function fakeTransfer () {
  return { startReceive () { return { received: new Set() } }, writeChunk () { return { ok: true } }, finalize () { return { ok: true } }, cancel () {}, pause () {} }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'p2-'))

test('#1b: cancelContent before the scheduler exists cancels the fetch at creation', async (t) => {
  const proto = new OverlayProtocolV2({}, fakeTransfer(), {})
  proto.cancelContent('zzz', { discardPartial: true }) // no scheduler yet → recorded in _cancelPending
  await t.exception(proto.fetchContent('zzz', [], { destPath: path.join(tmp(), 'z'), timeout: 200 }), /cancelled/,
    'fetchContent honors the pending cancel and rejects ECANCELLED — no requestContent sent')
})

test('#2: a concurrent same-hash fetch joins the in-flight one and copies the result', async (t) => {
  const proto = new OverlayProtocolV2({}, fakeTransfer(), {})
  const dir = tmp()
  const a = path.join(dir, 'a'); const b = path.join(dir, 'b')
  fs.writeFileSync(a, 'shared bytes') // the leader's assembled file

  const first = proto.fetchContent('abc', [], { destPath: a, timeout: 200 })
  const second = proto.fetchContent('abc', [], { destPath: b, timeout: 200 }) // joins (no 'already fetching' reject)
  t.is(proto._schedulers.size, 1, 'the join did not create a second scheduler')

  // Drive the leader to completion: an empty chunk list finalizes immediately.
  proto._onChunkHashes({ id: 'p' }, { path: 'content:abc', chunks: [] })
  await first
  await second
  t.is(fs.readFileSync(b).toString(), 'shared bytes', 'the joiner received a copy of the leader\'s verified bytes')
})

test('#1b: clearCancelPending drops a stale marker so the next same-hash fetch is not cancelled', async (t) => {
  const proto = new OverlayProtocolV2({}, fakeTransfer(), {})
  proto.cancelContent('ghi', { discardPartial: true }) // marks _cancelPending (no scheduler yet)
  proto.clearCancelPending('ghi')                       // fetchFile's no-peer abandon clears it
  const f = proto.fetchContent('ghi', [], { destPath: path.join(tmp(), 'g'), timeout: 200 })
  f.catch(() => {})
  t.is(proto._schedulers.size, 1, 'a normal scheduler exists — the stale cancel did not fire')
})

test('#2: a joiner re-issues its own fetch when the leader was cancelled', async (t) => {
  const proto = new OverlayProtocolV2({}, fakeTransfer(), {})
  const dir = tmp()
  const first = proto.fetchContent('def', [], { destPath: path.join(dir, 'a'), timeout: 200 })
  first.catch(() => {})
  const second = proto.fetchContent('def', [], { destPath: path.join(dir, 'b'), timeout: 200 }) // joins
  second.catch(() => {})
  proto.cancelContent('def', { discardPartial: true }) // cancel the leader → ECANCELLED
  // The joiner's ECANCELLED handler re-issues, creating a fresh scheduler for the same hash.
  await new Promise((r) => setTimeout(r, 20))
  t.is(proto._schedulers.size, 1, 'a fresh scheduler exists for the re-issued joiner (leader\'s was removed)')
})

// ── transfer-control (message 12): downloader→holder pause/stop signal ─────────

function fakePeer (sent) {
  return { msgs: { transferControl: { send: (m) => sent.push(m) } }, authorizedServe: new Map() }
}

// cancelContent only signals when a scheduler exists (an active fetch); seed one.
function seedScheduler (proto, contentHash) {
  proto._schedulers.set('content:' + contentHash, { destPath: '/x', cancel () {} })
}

test('REGRESSION (FIX-1): cancelContent pause broadcasts transferControl PAUSED', (t) => {
  const proto = new OverlayProtocolV2({}, fakeTransfer(), {})
  const sent = []
  proto._peers.set({}, fakePeer(sent))
  seedScheduler(proto, 'abc')
  proto.cancelContent('abc', { discardPartial: false })
  t.alike(sent, [{ contentHash: 'abc', state: 0 }], 'one PAUSED (state 0) sent before local teardown')
})

test('REGRESSION (FIX-2): cancelContent stop broadcasts transferControl STOPPED', (t) => {
  const proto = new OverlayProtocolV2({}, fakeTransfer(), {})
  const sent = []
  proto._peers.set({}, fakePeer(sent))
  seedScheduler(proto, 'abc')
  proto.cancelContent('abc', { discardPartial: true })
  t.alike(sent, [{ contentHash: 'abc', state: 1 }], 'one STOPPED (state 1) sent before local teardown')
})

test('cancelContent with signal:false (supersede) sends nothing', (t) => {
  const proto = new OverlayProtocolV2({}, fakeTransfer(), {})
  const sent = []
  proto._peers.set({}, fakePeer(sent))
  seedScheduler(proto, 'abc')
  proto.cancelContent('abc', { discardPartial: true, signal: false })
  t.is(sent.length, 0, 'a supersede restart suppresses the transfer-control broadcast')
})

test('cancelContent without a scheduler (pre-fetch cancel) sends nothing', (t) => {
  const proto = new OverlayProtocolV2({}, fakeTransfer(), {})
  const sent = []
  proto._peers.set({}, fakePeer(sent))
  proto.cancelContent('abc', { discardPartial: false }) // no scheduler → _cancelPending path
  t.is(sent.length, 0, 'no holder authorized us yet, so nothing is broadcast')
})

test('sendStopControl broadcasts STOPPED without a scheduler (discard-after-pause path)', (t) => {
  const proto = new OverlayProtocolV2({}, fakeTransfer(), {})
  const sent = []
  proto._peers.set({}, fakePeer(sent))
  proto.sendStopControl('abc')
  t.alike(sent, [{ contentHash: 'abc', state: 1 }], 'STOPPED sent directly, no scheduler required')
})

// The authorizedServe VALUE is a grant record — { from, epoch } — not a bare `from`. The epoch is
// what lets a membership change invalidate a grant that was cached at request time; every reader
// must go through .from. These two tests are the guard on that shape.
test('_onTransferControl maps to onServeControl using the authenticated authorizedServe identity', (t) => {
  const calls = []
  const proto = new OverlayProtocolV2({}, fakeTransfer(), { onServeControl: (info) => calls.push(info) })
  const peer = { authorizedServe: new Map([['content:abc', { from: 'peerProfileKey', epoch: 0 }]]) }
  proto._onTransferControl(peer, { contentHash: 'abc', state: 1 })
  proto._onTransferControl(peer, { contentHash: 'abc', state: 0 })
  t.is(calls.length, 2)
  t.alike(calls[0], { path: 'content:abc', peer, from: 'peerProfileKey', state: 'stopped' })
  t.alike(calls[1], { path: 'content:abc', peer, from: 'peerProfileKey', state: 'paused' })
})

test('_onTransferControl is a no-op for a hash the peer was never authorized to fetch (anti-spoof)', (t) => {
  const calls = []
  const proto = new OverlayProtocolV2({}, fakeTransfer(), { onServeControl: (info) => calls.push(info) })
  proto._onTransferControl({ authorizedServe: new Map() }, { contentHash: 'zzz', state: 1 })
  t.is(calls.length, 0, 'no ledger callback without an authenticated serve record')
})

test('_sendTransferControl tolerates a peer that predates slot 12 (no throw)', (t) => {
  const proto = new OverlayProtocolV2({}, fakeTransfer(), {})
  proto._peers.set({}, { msgs: {}, authorizedServe: new Map() }) // old peer: no transferControl slot
  seedScheduler(proto, 'abc')
  try { proto.cancelContent('abc', { discardPartial: false }); t.pass('cancelContent did not throw') }
  catch (err) { t.fail('threw: ' + err.message) }
})

// ── transfer-progress (message 13): downloader→holder resume have-baseline ──────

test('sendTransferProgress broadcasts the have-baseline to every connected holder', (t) => {
  const proto = new OverlayProtocolV2({}, fakeTransfer(), {})
  const sent = []
  proto._peers.set({}, { msgs: { transferProgress: { send: (m) => sent.push(m) } }, authorizedServe: new Map() })
  proto.sendTransferProgress('abc', 700)
  t.alike(sent, [{ contentHash: 'abc', have: 700 }], 'have-baseline broadcast to the holder')
})

test('_onTransferProgress maps to onServeProgress using the authenticated authorizedServe identity', (t) => {
  const calls = []
  const proto = new OverlayProtocolV2({}, fakeTransfer(), { onServeProgress: (info) => calls.push(info) })
  const peer = { authorizedServe: new Map([['content:abc', { from: 'peerProfileKey', epoch: 0 }]]) }
  proto._onTransferProgress(peer, { contentHash: 'abc', have: 700 })
  t.is(calls.length, 1)
  t.alike(calls[0], { path: 'content:abc', peer, from: 'peerProfileKey', have: 700 })
})

test('_onTransferProgress is a no-op for a hash the peer was never authorized to fetch (anti-spoof)', (t) => {
  const calls = []
  const proto = new OverlayProtocolV2({}, fakeTransfer(), { onServeProgress: (info) => calls.push(info) })
  proto._onTransferProgress({ authorizedServe: new Map() }, { contentHash: 'zzz', have: 700 })
  t.is(calls.length, 0, 'no ledger callback without an authenticated serve record')
})

test('sendTransferProgress tolerates a peer that predates slot 13 (no throw)', (t) => {
  const proto = new OverlayProtocolV2({}, fakeTransfer(), {})
  proto._peers.set({}, { msgs: {}, authorizedServe: new Map() }) // old peer: no transferProgress slot
  try { proto.sendTransferProgress('abc', 700); t.pass('sendTransferProgress did not throw') }
  catch (err) { t.fail('threw: ' + err.message) }
})
