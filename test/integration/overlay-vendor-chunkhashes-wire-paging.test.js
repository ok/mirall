// [mirall] §4.12 — chunk-hashes wire paging. A very large file's chunk list,
// shipped in one `chunkHashes` Protomux frame, exceeds the Noise transport's
// 16 MiB-1 atomic-write limit (@hyperswarm/secret-stream MAX_ATOMIC_WRITE). The
// holder's send threw "Message is too large for an atomic write", the swarm
// dropped the connection, and the requester stalled at 0/N bytes and timed out
// ("no holder") — a 1.25 TB .mov never transferred a single byte. The protocol
// now pages the list into frames each under the limit and reassembles them on
// the receiver. The public flow (scheduler.onChunkHashes with the full list) is
// unchanged.
import test from 'brittle'
import * as m from '../../src/shared/transfer/backends/overlay/vendor/messages-v2.js'
import { OverlayProtocolV2 } from '../../src/shared/transfer/backends/overlay/vendor/protocol-v2.js'

// @hyperswarm/secret-stream rejects any frame whose payload exceeds this
// (MAX_ATOMIC_WRITE = 256**3 - 1); the encrypted wrapper adds ABYTES on top, so
// the real payload ceiling is a bit lower still.
const MAX_ATOMIC_WRITE = 256 * 256 * 256 - 1

function fakeTransfer () {
  return { startReceive () { return { received: new Set() } }, writeChunk () { return { ok: true } }, finalize () { return { ok: true } }, cancel () {}, pause () {} }
}

// Exact encoded byte length of a chunkHashes frame (what hits secret-stream).
function encodedSize (msg) {
  const state = { start: 0, end: 0, buffer: null }
  m.chunkHashes.preencode(state, msg)
  return state.end
}

// A chunk list big enough that one frame blows MAX_ATOMIC_WRITE. ~37 B/entry on
// the wire, so 500k entries ≈ ~18 MB > 16 MiB-1 — and >> MAX_CHUNKS_PER_MSG so
// the sender must page. Distinct lengths let us assert order is preserved; the
// hash is constant to keep the test fast (the encoder re-buffers it either way).
function bigChunkList (count) {
  const hash = 'a'.repeat(64)
  const chunks = new Array(count)
  for (let i = 0; i < count; i++) chunks[i] = { hash, length: 262144 + (i % 4096) }
  return chunks
}

test('REGRESSION (FIX-12): a 1.25 TB-scale chunk list overflows one frame but pages stay under the limit', (t) => {
  const chunks = bigChunkList(500000)

  // The bug: the whole list as a single frame is rejected by secret-stream.
  const oneFrame = encodedSize({ path: 'content:big', tier: 3, chunks, more: 0 })
  t.ok(oneFrame > MAX_ATOMIC_WRITE, `single frame (${oneFrame} B) exceeds the ${MAX_ATOMIC_WRITE} B atomic-write limit`)

  // The fix: _sendChunkHashes splits it into frames that each fit.
  const proto = new OverlayProtocolV2({}, fakeTransfer(), {})
  const sent = []
  const peer = { msgs: { chunkHashes: { send: (msg) => sent.push(msg) } } }
  proto._sendChunkHashes(peer, 'content:big', 3, chunks)

  t.ok(sent.length > 1, `paged into ${sent.length} frames`)
  for (const f of sent) {
    // 64 KiB headroom covers the Protomux header + secret-stream ABYTES.
    t.ok(encodedSize(f) <= MAX_ATOMIC_WRITE - 65536, `page frame ${encodedSize(f)} B fits under the limit`)
  }

  // Every page but the last is more:1; the last is more:0.
  for (let i = 0; i < sent.length; i++) {
    t.is(sent[i].more, i === sent.length - 1 ? 0 : 1, `page ${i} more flag`)
    t.is(sent[i].path, 'content:big', 'path repeated on every page')
    t.is(sent[i].tier, 3, 'tier repeated on every page')
  }

  // Pages concatenate back to the exact original list (count + order).
  const rebuilt = sent.flatMap((f) => f.chunks)
  t.is(rebuilt.length, chunks.length, 'no chunks lost across pages')
  t.is(rebuilt[0].length, chunks[0].length, 'first chunk preserved')
  t.is(rebuilt[rebuilt.length - 1].length, chunks[chunks.length - 1].length, 'last chunk preserved')
})

test('FIX-12: the receiver reassembles paged frames and dispatches the full list once', (t) => {
  const chunks = bigChunkList(250000)
  const proto = new OverlayProtocolV2({}, fakeTransfer(), {})

  // Page on the send side to get realistic frames, then feed them to the receiver.
  const sent = []
  const sender = { msgs: { chunkHashes: { send: (msg) => sent.push(msg) } } }
  proto._sendChunkHashes(sender, 'content:x', 3, chunks)
  t.ok(sent.length > 1, 'multiple pages to reassemble')

  // A fake scheduler stands in for the multi-source fetch — it only needs to
  // capture the dispatched list and count progress pings.
  let dispatched = null
  let dispatchCount = 0
  let pings = 0
  proto._schedulers.set('content:x', {
    onChunkHashes (peer, list) { dispatchCount++; dispatched = list },
    notePageProgress () { pings++ }
  })

  const peer = { id: 'p1' }
  for (const f of sent) proto._onChunkHashes(peer, f)

  t.is(dispatchCount, 1, 'scheduler.onChunkHashes fired exactly once (on the final page)')
  t.is(dispatched.length, chunks.length, 'full list reassembled in order')
  t.is(dispatched[chunks.length - 1].length, chunks[chunks.length - 1].length, 'last entry intact')
  t.is(pings, sent.length - 1, 'every non-final page re-armed the watchdog')
  t.absent(peer._chunkHashPages.has('content:x'), 'per-path page buffer cleared after the final page')
})

test('FIX-12: a small list still ships as one frame and dispatches immediately', (t) => {
  const chunks = [{ hash: 'b'.repeat(64), length: 16384 }, { hash: 'c'.repeat(64), length: 8192 }]
  const proto = new OverlayProtocolV2({}, fakeTransfer(), {})

  const sent = []
  const sender = { msgs: { chunkHashes: { send: (msg) => sent.push(msg) } } }
  proto._sendChunkHashes(sender, 'content:s', 0, chunks)
  t.is(sent.length, 1, 'single frame for a small list')
  t.is(sent[0].more, 0, 'lone frame is final')

  let dispatched = null
  proto._schedulers.set('content:s', { onChunkHashes (peer, list) { dispatched = list } })
  const peer = { id: 'p2' }
  proto._onChunkHashes(peer, sent[0])
  t.is(dispatched, chunks, 'lone complete frame passes straight through (no copy)')
})

test('FIX-12: pages for two files interleaved on one channel reassemble independently', (t) => {
  const proto = new OverlayProtocolV2({}, fakeTransfer(), {})
  const peer = { id: 'p3' }
  const got = {}
  proto._schedulers.set('content:A', { onChunkHashes (_p, list) { got.A = list }, notePageProgress () {} })
  proto._schedulers.set('content:B', { onChunkHashes (_p, list) { got.B = list }, notePageProgress () {} })

  const a1 = { hash: 'a'.repeat(64), length: 1 }
  const a2 = { hash: 'a'.repeat(64), length: 2 }
  const b1 = { hash: 'b'.repeat(64), length: 3 }
  const b2 = { hash: 'b'.repeat(64), length: 4 }

  // Interleave A and B pages on the same peer/channel.
  proto._onChunkHashes(peer, { path: 'content:A', tier: 0, chunks: [a1], more: 1 })
  proto._onChunkHashes(peer, { path: 'content:B', tier: 0, chunks: [b1], more: 1 })
  proto._onChunkHashes(peer, { path: 'content:A', tier: 0, chunks: [a2], more: 0 })
  proto._onChunkHashes(peer, { path: 'content:B', tier: 0, chunks: [b2], more: 0 })

  t.alike(got.A, [a1, a2], 'file A reassembled from its own pages')
  t.alike(got.B, [b1, b2], 'file B reassembled from its own pages')
})
