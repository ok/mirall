import test from 'brittle'
import { OverlayProtocolV2 } from '../../src/shared/transfer/backends/overlay/vendor/protocol-v2.js'

// chunkData, mirall/handshake, and the Corestore replication that carries a peer's
// freshly shared folder all multiplex over ONE Noise stream. The seeder must stop
// piling chunkData onto a backpressured stream (protomux MAX_BACKLOG is Infinity),
// or a peer mid-download never sees a new share until the transfer pauses. These
// drive _onChunkNeed directly with a peer whose stream reports backpressure.

const tick = () => new Promise((r) => setTimeout(r, 0))

function fakeTransfer (chunkMap, bytes) {
  return {
    _fileIndex: { getChunkMap: async () => chunkMap, getChunkMapByHash: async () => chunkMap },
    readChunk: (_p, off, len) => bytes.subarray(off, off + len),
    startReceive () { return { received: new Set() } },
    writeChunk () { return { ok: true } },
    finalize () { return { ok: true } },
    cancel () {}, pause () {},
  }
}

// send() always reports backpressure (returns false + marks the stream not-drained),
// so the seeder parks after every chunk; drain() clears it and fires 'drain'.
function backpressuredPeer () {
  const sent = []
  let drained = true
  const ls = { drain: [], close: [] }
  const stream = {
    on (ev, fn) { (ls[ev] ||= []).push(fn) },
    removeListener (ev, fn) { ls[ev] = (ls[ev] || []).filter((f) => f !== fn) },
    emit (ev, ...a) { for (const fn of [...(ls[ev] || [])]) fn(...a) },
  }
  const peer = {
    mux: { stream },
    channel: { closed: false, get drained () { return drained } },
    authorizedServe: new Map(),
    msgs: { chunkData: { send (m) { sent.push(m); drained = false; return false } } },
  }
  return {
    peer, sent,
    drain () { drained = true; stream.emit('drain') },
    closeChannel () { peer.channel.closed = true; stream.emit('close') },
  }
}

const map3 = () => [
  { hash: 'a', offset: 0, length: 4 },
  { hash: 'b', offset: 4, length: 4 },
  { hash: 'c', offset: 8, length: 4 },
]

test('REGRESSION (FIX-1): seeder parks on backpressure and resumes on drain (no unbounded send)', async (t) => {
  const proto = new OverlayProtocolV2({}, fakeTransfer(map3(), Buffer.alloc(12, 7)), {
    filePaths: new Map([['content:abc', '/disk/abc']]),
  })
  const { peer, sent, drain } = backpressuredPeer()

  const p = proto._onChunkNeed(peer, { path: 'content:abc', indices: [0, 1, 2] })
  await tick()
  t.is(sent.length, 1, 'sent only the first chunk, then parked on backpressure (NOT all 3)')
  drain(); await tick()
  t.is(sent.length, 2, 'resumed and sent the second chunk after drain')
  drain(); await tick()
  t.is(sent.length, 3, 'sent the third chunk after the next drain')
  await p
  t.pass('serve loop completed')
})

test('FIX-1: a drained stream sends the whole batch in one pass (fast-path unchanged)', async (t) => {
  const proto = new OverlayProtocolV2({}, fakeTransfer(map3(), Buffer.alloc(12, 7)), {
    filePaths: new Map([['content:abc', '/disk/abc']]),
  })
  const sent = []
  const peer = {
    mux: { stream: { on () {}, removeListener () {}, emit () {} } },
    channel: { closed: false, drained: true },
    authorizedServe: new Map(),
    msgs: { chunkData: { send (m) { sent.push(m); return true } } },
  }
  await proto._onChunkNeed(peer, { path: 'content:abc', indices: [0, 1, 2] })
  t.is(sent.length, 3, 'all chunks flushed when the stream is not backpressured')
})

test('FIX-1: a channel that closes while parked stops the serve loop (no send after close)', async (t) => {
  const proto = new OverlayProtocolV2({}, fakeTransfer(map3(), Buffer.alloc(12, 7)), {
    filePaths: new Map([['content:abc', '/disk/abc']]),
  })
  const { peer, sent, closeChannel } = backpressuredPeer()
  const p = proto._onChunkNeed(peer, { path: 'content:abc', indices: [0, 1, 2] })
  await tick()
  t.is(sent.length, 1, 'first chunk sent, then parked')
  closeChannel(); await p
  t.is(sent.length, 1, 'no further chunks sent after the channel closed mid-transfer')
})

test('FIX-1: per-chunk serve telemetry still fires before the backpressure wait', async (t) => {
  const served = []
  const proto = new OverlayProtocolV2({}, fakeTransfer(map3(), Buffer.alloc(12, 7)), {
    filePaths: new Map([['content:abc', '/disk/abc']]),
    onChunkServe: (info) => served.push(info.index),
  })
  const { peer, drain } = backpressuredPeer()
  const p = proto._onChunkNeed(peer, { path: 'content:abc', indices: [0, 1, 2] })
  await tick(); drain(); await tick(); drain(); await tick()
  await p
  t.alike(served, [0, 1, 2], 'onChunkServe fired once per chunk despite the parking')
})

test('_onChunkNeed skips a chunk whose readChunk returns null and serves the rest', async (t) => {
  const transfer = fakeTransfer(map3(), Buffer.alloc(12, 7))
  transfer.readChunk = (_p, off) => (off === 4 ? null : Buffer.alloc(4, 7)) // index 1 unreadable
  const proto = new OverlayProtocolV2({}, transfer, {
    filePaths: new Map([['content:abc', '/disk/abc']]),
  })
  const sent = []
  const peer = {
    mux: { stream: { on () {}, removeListener () {}, emit () {} } },
    channel: { closed: false, drained: true },
    authorizedServe: new Map(),
    msgs: { chunkData: { send (m) { sent.push(m.index); return true } } },
  }
  await proto._onChunkNeed(peer, { path: 'content:abc', indices: [0, 1, 2] })
  t.alike(sent, [0, 2], 'the null chunk (index 1) is skipped; 0 and 2 still served')
})
