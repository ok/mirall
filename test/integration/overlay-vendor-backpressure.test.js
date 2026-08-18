import test from 'brittle'
import { OverlayProtocolV2 } from '../../src/shared/transfer/backends/overlay/vendor/protocol-v2.js'
import { createBandwidthLimiter } from '../../src/shared/transfer/bandwidth-limiter.js'
import * as m from '../../src/shared/transfer/backends/overlay/vendor/messages-v2.js'

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

// --- upload cap -------------------------------------------------------------
// The serve side of the bandwidth limiter, which no unit test can reach: `_onChunkNeed` is
// where take() is awaited, where an aborted wait must stop the send, and where one handle is
// shared by every concurrent serve loop for a peer.

const KB = 1024

function drainedPeer () {
  const sent = []
  const peer = {
    mux: { stream: { on () {}, removeListener () {}, emit () {} } },
    channel: { closed: false, drained: true },
    authorizedServe: new Map(),
    uploadStream: null,
    msgs: { chunkData: { send (m) { sent.push(m); return true } } },
  }
  return { peer, sent }
}

const bigMap = (n, len) => Array.from({ length: n }, (_, i) => ({ hash: 'h' + i, offset: i * len, length: len }))

test('upload cap: the serve loop is paced by the cap rather than flushing the batch', async (t) => {
  const LEN = 16 * KB
  const map = bigMap(8, LEN)
  const limiter = createBandwidthLimiter(() => 32 * KB)   // 2 chunks/second
  const proto = new OverlayProtocolV2({}, fakeTransfer(map, Buffer.alloc(8 * LEN, 7)), {
    filePaths: new Map([['content:abc', '/disk/abc']]),
    uploadLimiter: limiter,
  })
  const { peer, sent } = drainedPeer()

  const p = proto._onChunkNeed(peer, { path: 'content:abc', indices: [0, 1, 2, 3, 4, 5, 6, 7] })
  await new Promise((r) => setTimeout(r, 600))
  const early = sent.length
  t.ok(early > 0, `some chunks went out (${early})`)
  t.ok(early < 8, `but the batch was paced, not flushed (${early}/8 after 600ms at 32 KB/s)`)

  limiter.destroy()   // releases the parked wait so the loop can finish
  await p
  t.pass('the serve loop unwinds cleanly')
})

// REGRESSION (FIX-BW6): protomux does not serialise its async onmessage handlers, so two
// chunkNeed messages for ONE peer run concurrently against that peer's single upload handle.
// Overwriting the handle's pending request threw out of the limiter's pump and killed the
// worker; the handle now serialises them.
test('REGRESSION (FIX-BW6): concurrent serve loops on one peer do not corrupt the handle', async (t) => {
  const LEN = 4 * KB
  const map = bigMap(6, LEN)
  const limiter = createBandwidthLimiter(() => 64 * KB)
  const proto = new OverlayProtocolV2({}, fakeTransfer(map, Buffer.alloc(6 * LEN, 7)), {
    filePaths: new Map([['content:abc', '/disk/abc']]),
    uploadLimiter: limiter,
  })
  const { peer, sent } = drainedPeer()

  // Corruption showed up as a throw out of the limiter's pump, which strands both loops —
  // so "every chunk arrived and both awaits resolved" is the assertion that catches it.
  await Promise.all([
    proto._onChunkNeed(peer, { path: 'content:abc', indices: [0, 1, 2] }),
    proto._onChunkNeed(peer, { path: 'content:abc', indices: [3, 4, 5] }),
  ])
  limiter.destroy()

  t.is(sent.length, 6, 'both serve loops delivered their whole batch')
  t.alike(sent.map((m) => m.index).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5], 'no chunk lost or duplicated')
})

// A take() that resolves 0 means the wait was aborted; sending anyway would put unmetered
// bytes on a channel that is very likely gone.
test('upload cap: an aborted wait stops the serve loop instead of sending unpaid bytes', async (t) => {
  const LEN = 64 * KB
  const map = bigMap(4, LEN)
  const limiter = createBandwidthLimiter(() => 32 * KB)   // one chunk is 2s of budget
  const proto = new OverlayProtocolV2({}, fakeTransfer(map, Buffer.alloc(4 * LEN, 7)), {
    filePaths: new Map([['content:abc', '/disk/abc']]),
    uploadLimiter: limiter,
  })
  const { peer, sent } = drainedPeer()

  const p = proto._onChunkNeed(peer, { path: 'content:abc', indices: [0, 1, 2, 3] })
  await new Promise((r) => setTimeout(r, 100))
  const before = sent.length
  limiter.destroy()                                        // abort the parked wait
  await p
  await new Promise((r) => setTimeout(r, 50))
  t.is(sent.length, before, 'nothing was sent after the wait was aborted')
})

// --- keep-alive while parked on the upload cap (FIX-BW9) --------------------
// A serve loop waiting on take() puts NOTHING on the wire, so once the wait exceeds the
// downloader's no-progress watchdog (30s), a healthy capped holder is indistinguishable from
// a wedged one and the downloader aborts a transfer that was merely paced. Message 14 is the
// only thing that separates them.

test('REGRESSION (FIX-BW9): a serve loop parked on the upload cap sends keep-alives', async (t) => {
  const LEN = 64 * KB
  const map = bigMap(4, LEN)
  const limiter = createBandwidthLimiter(() => 32 * KB)   // one chunk costs 2s: a long park
  const proto = new OverlayProtocolV2({}, fakeTransfer(map, Buffer.alloc(4 * LEN, 7)), {
    filePaths: new Map([['content:abc', '/disk/abc']]),
    uploadLimiter: limiter,
    keepAliveInterval: 50,
  })
  const { peer, sent } = drainedPeer()
  const alive = []
  peer.msgs.keepAlive = { send: (m) => alive.push(m) }

  const p = proto._onChunkNeed(peer, { path: 'content:abc', indices: [0, 1, 2, 3] })
  await new Promise((r) => setTimeout(r, 400))
  t.ok(alive.length >= 3, `the holder announced itself while parked (${alive.length} keep-alive(s))`)
  t.is(alive[0].contentHash, 'abc', 'addressed to the content being served')
  t.ok(alive.every((m) => typeof m.index === 'number'), 'each names the chunk being paid for')
  t.ok(sent.length < 4, `and the batch really was still paced (${sent.length}/4 sent)`)

  limiter.destroy()
  await p
  const settled = alive.length
  await new Promise((r) => setTimeout(r, 200))
  t.is(alive.length, settled, 'the keep-alive timer is cleared once the loop unwinds')
})

// A cap that is never actually WAITED on must stay silent — the announcement exists for the
// wait, not for the cap. (An unlimited cap proves nothing here: `_onChunkNeed` short-circuits on
// `isUnlimited()` before the keep-alive code is reached, so that version of this test passed
// even with `_takeWithKeepAlive` deleted outright.)
test('FIX-BW9: chunks paid for without waiting send no keep-alives', async (t) => {
  const LEN = 4 * KB
  const map = bigMap(3, LEN)
  const limiter = createBandwidthLimiter(() => 8 * 1024 * KB)   // capped, but 8 MB/s: no wait
  const proto = new OverlayProtocolV2({}, fakeTransfer(map, Buffer.alloc(3 * LEN, 7)), {
    filePaths: new Map([['content:abc', '/disk/abc']]),
    uploadLimiter: limiter,
    keepAliveInterval: 10,
  })
  const { peer, sent } = drainedPeer()
  const alive = []
  peer.msgs.keepAlive = { send: (m) => alive.push(m) }

  await proto._onChunkNeed(peer, { path: 'content:abc', indices: [0, 1, 2] })
  await new Promise((r) => setTimeout(r, 60))   // several keep-alive intervals
  limiter.destroy()

  t.is(sent.length, 3, 'the batch went out under the cap without ever parking')
  t.is(alive.length, 0, 'so nothing was announced, and no interval was left running')
})

test('FIX-BW9: a peer that predates message 14 is served exactly as before', async (t) => {
  const LEN = 16 * KB
  const map = bigMap(2, LEN)
  const limiter = createBandwidthLimiter(() => 64 * KB)
  const proto = new OverlayProtocolV2({}, fakeTransfer(map, Buffer.alloc(2 * LEN, 7)), {
    filePaths: new Map([['content:abc', '/disk/abc']]),
    uploadLimiter: limiter,
    keepAliveInterval: 10,
  })
  const { peer, sent } = drainedPeer()   // no peer.msgs.keepAlive: an older overlay peer

  await proto._onChunkNeed(peer, { path: 'content:abc', indices: [0, 1] })
  limiter.destroy()
  t.is(sent.length, 2, 'the serve loop still delivers the batch, with no slot-14 send attempted')
})

// The whole backward-compatibility argument for message 14 rests on it being registered
// LAST: protomux dispatches by positional id, so inserting a message anywhere else shifts
// every id after it and silently mis-routes frames between versions. Slots 0-13 are frozen.
test('FIX-BW9: keep-alive is registered last, leaving every existing message id fixed', (t) => {
  const proto = new OverlayProtocolV2({}, fakeTransfer(map3(), Buffer.alloc(12, 7)), {})
  const order = []
  const fakeMux = {
    stream: { on () {}, removeListener () {}, emit () {} },
    createChannel: () => ({
      addMessage ({ encoding }) {
        const name = Object.keys(m).find((k) => m[k] === encoding) || 'unknown'
        order.push(name)
        return { send () {} }
      },
      open () {},
    }),
  }
  proto.attach(fakeMux)

  t.alike(order, [
    'syncState', 'fileOffer', 'fileRequest', 'chunkHashes', 'chunkNeed', 'chunkData',
    'chunkCancel', 'transferComplete', 'conflict', 'treeRequest', 'treeResponse',
    'contentRequest', 'transferControl', 'transferProgress', 'keepAlive',
  ], 'keep-alive took slot 14; ids 0-13 are unmoved')
})

// A keep-alive names a content hash, so it is an outbound content frame like any other and must
// stop the instant the grant does. Left ungated it tells a peer whose membership was just
// revoked that we hold and are actively serving that hash — the membership oracle the serve gate
// exists to deny — and holds its watchdog open instead of letting the fetch fail promptly.
test('REGRESSION (FIX-BW9): revoking a serve grant mid-park stops the keep-alives', async (t) => {
  const LEN = 64 * KB
  const map = bigMap(4, LEN)
  const limiter = createBandwidthLimiter(() => 32 * KB)      // 2s per chunk: a long park
  const proto = new OverlayProtocolV2({}, fakeTransfer(map, Buffer.alloc(4 * LEN, 7)), {
    filePaths: new Map([['content:abc', '/disk/abc']]),
    uploadLimiter: limiter,
    keepAliveInterval: 30,
    serveAuthorizer: async () => true,
  })
  const { peer } = drainedPeer()
  const alive = []
  peer.msgs.keepAlive = { send: (m) => alive.push(m) }
  peer.authorizedServe.set('content:abc', { from: 'them', epoch: 0 })
  proto._peers.set(peer.mux, peer)           // revokeServes walks _peers, not the passed peer

  const p = proto._onChunkNeed(peer, { path: 'content:abc', indices: [0, 1, 2, 3] })
  await new Promise((r) => setTimeout(r, 150))
  t.ok(alive.length > 0, `announcing while the grant stands (${alive.length})`)

  proto.revokeServes(() => true)             // member removed / space left, mid-park
  const atRevoke = alive.length
  await new Promise((r) => setTimeout(r, 200))
  t.is(alive.length, atRevoke, 'not one frame after the grant was revoked')

  limiter.destroy()
  await p
})
