// [mirall] §4.15 — tree-response wire paging (GH #357). A directory tree with enough
// entries, shipped in one treeResponse frame, exceeds the Noise transport's 16 MiB-1
// atomic-write limit (@hyperswarm/secret-stream MAX_ATOMIC_WRITE), the same class of
// failure #295 fixed for chunkHashes. The tree path is dormant in mirall's live flow
// (serveAuthorizer gate + no requestTree caller), so this drives the vendored protocol
// directly, mirroring the shipped chunkHashes paging test.
import test from 'brittle'
import * as m from '../../src/shared/transfer/backends/overlay/vendor/messages-v2.js'
import { OverlayProtocolV2 } from '../../src/shared/transfer/backends/overlay/vendor/protocol-v2.js'

const MAX_ATOMIC_WRITE = 256 * 256 * 256 - 1

function encodedSize (msg) {
  const state = { start: 0, end: 0, buffer: null }
  m.treeResponse.preencode(state, msg)
  return state.end
}

// A tree big enough that one frame blows MAX_ATOMIC_WRITE. Distinct names + sizes let us
// assert order is preserved across pages; the long name inflates each entry (~240 B).
function bigTree (count) {
  const childHash = 'a'.repeat(64)
  const entries = new Array(count)
  for (let i = 0; i < count; i++) {
    entries[i] = { kind: 0, exec: 0, name: 'file-' + i + '-'.repeat(200), childHash, size: i }
  }
  return entries
}

function fakePeer () {
  return { pendingTrees: new Map(), msgs: { treeRequest: { send () {} } } }
}

async function rejection (promise) {
  try { await promise; return null } catch (err) { return err }
}

test('REGRESSION (FIX-357): a directory tree overflows one frame but pages stay under the limit', (t) => {
  const entries = bigTree(80000)

  const oneFrame = encodedSize({ hash: 'a'.repeat(64), entries, more: 0, nonce: 0 })
  t.ok(oneFrame > MAX_ATOMIC_WRITE, `single frame (${oneFrame} B) exceeds the ${MAX_ATOMIC_WRITE} B atomic-write limit`)

  const proto = new OverlayProtocolV2({}, {}, {})
  const sent = []
  const peer = { msgs: { treeResponse: { send: (msg) => sent.push(msg) } } }
  proto._sendTreeResponse(peer, 'a'.repeat(64), entries, 0)

  t.ok(sent.length > 1, `paged into ${sent.length} frames`)
  for (const f of sent) {
    // 64 KiB headroom covers the Protomux header + secret-stream ABYTES.
    t.ok(encodedSize(f) <= MAX_ATOMIC_WRITE - 65536, `page frame ${encodedSize(f)} B fits under the limit`)
  }
  for (let i = 0; i < sent.length; i++) {
    t.is(sent[i].more, i === sent.length - 1 ? 0 : 1, `page ${i} more flag`)
    t.is(sent[i].hash, 'a'.repeat(64), 'hash repeated on every page')
  }
  const rebuilt = sent.flatMap((f) => f.entries)
  t.is(rebuilt.length, entries.length, 'no entries lost across pages')
  t.is(rebuilt[0].name, entries[0].name, 'first entry preserved')
  t.is(rebuilt[rebuilt.length - 1].name, entries[entries.length - 1].name, 'last entry preserved')
})

test('FIX-357: the receiver reassembles paged frames and resolves requestTree once', async (t) => {
  const entries = bigTree(40000)
  const proto = new OverlayProtocolV2({}, {}, {})
  const hash = 'a'.repeat(64)
  const peer = fakePeer()
  const p = proto.requestTree(peer, hash, { timeout: 5000 })
  const nonce = peer.pendingTrees.get(hash).nonce

  // Page on the send side (echoing the request nonce), then feed the frames back.
  const sent = []
  const sender = { msgs: { treeResponse: { send: (msg) => sent.push(msg) } } }
  proto._sendTreeResponse(sender, hash, entries, nonce)
  t.ok(sent.length > 1, 'multiple pages to reassemble')
  for (const f of sent) proto._onTreeResponse(peer, f)

  const got = await p
  t.is(got.length, entries.length, 'full tree reassembled in order')
  t.is(got[entries.length - 1].name, entries[entries.length - 1].name, 'last entry intact')
  t.absent(peer.pendingTrees.has(hash), 'pending request + its page buffer cleared')
})

test('FIX-357: a small tree still ships as one frame and resolves immediately', async (t) => {
  const entries = [{ kind: 0, exec: 0, name: 'a.js', childHash: 'b'.repeat(64), size: 1 }]
  const proto = new OverlayProtocolV2({}, {}, {})
  const hash = 'c'.repeat(64)
  const peer = fakePeer()
  const p = proto.requestTree(peer, hash, { timeout: 5000 })
  const nonce = peer.pendingTrees.get(hash).nonce

  const sent = []
  const sender = { msgs: { treeResponse: { send: (msg) => sent.push(msg) } } }
  proto._sendTreeResponse(sender, hash, entries, nonce)
  t.is(sent.length, 1, 'single frame for a small tree')
  t.is(sent[0].more, 0, 'lone frame is final')

  proto._onTreeResponse(peer, sent[0])
  t.alike(await p, entries, 'lone complete frame resolves the request')
})

test('FIX-357: an empty tree ships as one final frame', (t) => {
  const proto = new OverlayProtocolV2({}, {}, {})
  const sent = []
  const peer = { msgs: { treeResponse: { send: (msg) => sent.push(msg) } } }
  proto._sendTreeResponse(peer, 'd'.repeat(64), [], 0)
  t.is(sent.length, 1, 'single frame for an empty tree')
  t.is(sent[0].more, 0, 'lone frame is final')
  t.alike(sent[0].entries, [], 'no entries')
})

test('FIX-357: pages for two trees interleaved on one channel reassemble independently', async (t) => {
  const proto = new OverlayProtocolV2({}, {}, {})
  const hA = 'a'.repeat(64)
  const hB = 'b'.repeat(64)
  const peer = fakePeer()
  const pA = proto.requestTree(peer, hA, { timeout: 5000 })
  const pB = proto.requestTree(peer, hB, { timeout: 5000 })
  const nA = peer.pendingTrees.get(hA).nonce
  const nB = peer.pendingTrees.get(hB).nonce

  const a1 = { kind: 0, exec: 0, name: 'a1', childHash: hA, size: 1 }
  const a2 = { kind: 0, exec: 0, name: 'a2', childHash: hA, size: 2 }
  const b1 = { kind: 0, exec: 0, name: 'b1', childHash: hB, size: 3 }
  const b2 = { kind: 0, exec: 0, name: 'b2', childHash: hB, size: 4 }

  proto._onTreeResponse(peer, { hash: hA, entries: [a1], more: 1, nonce: nA })
  proto._onTreeResponse(peer, { hash: hB, entries: [b1], more: 1, nonce: nB })
  proto._onTreeResponse(peer, { hash: hA, entries: [a2], more: 0, nonce: nA })
  proto._onTreeResponse(peer, { hash: hB, entries: [b2], more: 0, nonce: nB })

  t.alike(await pA, [a1, a2], 'tree A reassembled from its own pages')
  t.alike(await pB, [b1, b2], 'tree B reassembled from its own pages')
})

test('FIX-357: an oversized paged tree response is rejected at the byte cap', async (t) => {
  const proto = new OverlayProtocolV2({}, {}, { maxTreeResponseBytes: 4096 })
  const hash = 'e'.repeat(64)
  const peer = fakePeer()
  const p = proto.requestTree(peer, hash, { timeout: 5000 })
  const nonce = peer.pendingTrees.get(hash).nonce

  // ~49 B/entry × 50 ≈ 2450 B/page; two pages exceed the 4096 B cap.
  const page = () => Array.from({ length: 50 }, (_, i) => ({ kind: 0, exec: 0, name: 'n' + i, childHash: 'a'.repeat(64), size: i }))
  proto._onTreeResponse(peer, { hash, entries: page(), more: 1, nonce })
  proto._onTreeResponse(peer, { hash, entries: page(), more: 1, nonce })

  const err = await rejection(p)
  t.ok(err && /tree response too large/.test(err.message), 'rejects once accumulated bytes exceed the cap')
  t.absent(peer.pendingTrees.has(hash), 'pending + buffer cleared on cap rejection')
})

test('FIX-357: a stale page from a superseded request cannot settle a same-hash retry', async (t) => {
  const proto = new OverlayProtocolV2({}, {}, {})
  const hash = 'f'.repeat(64)
  const peer = fakePeer()
  const stale = { kind: 0, exec: 0, name: 'stale', childHash: hash, size: 1 }

  // Request #1 buffers a page, then is force-failed (as a timeout would) → caller retries.
  const p1 = proto.requestTree(peer, hash, { timeout: 5000 })
  const n1 = peer.pendingTrees.get(hash).nonce
  proto._onTreeResponse(peer, { hash, entries: [stale], more: 1, nonce: n1 })
  proto._failPendingTrees(peer, new Error('timed out'))
  t.ok(await rejection(p1), '#1 rejected')

  // Retry (#2) gets a distinct nonce.
  const p2 = proto.requestTree(peer, hash, { timeout: 5000 })
  const n2 = peer.pendingTrees.get(hash).nonce
  t.not(n1, n2, 'retry gets a distinct nonce')

  // #1's in-flight FINAL page arrives now — must be DROPPED (stale nonce), not resolve #2.
  proto._onTreeResponse(peer, { hash, entries: [stale], more: 0, nonce: n1 })
  t.ok(peer.pendingTrees.has(hash), '#2 still pending — stale final page did not settle it')

  // #2's own real pages resolve it correctly.
  const real = [
    { kind: 0, exec: 0, name: 'real-a', childHash: hash, size: 2 },
    { kind: 0, exec: 0, name: 'real-b', childHash: hash, size: 3 }
  ]
  proto._onTreeResponse(peer, { hash, entries: [real[0]], more: 1, nonce: n2 })
  proto._onTreeResponse(peer, { hash, entries: [real[1]], more: 0, nonce: n2 })
  t.alike(await p2, real, '#2 resolves with only its own entries')
})

test('FIX-357: a pre-nonce holder (nonce 0) is accepted best-effort', async (t) => {
  const proto = new OverlayProtocolV2({}, {}, {})
  const hash = 'ab'.repeat(32)
  const peer = fakePeer()
  const p = proto.requestTree(peer, hash, { timeout: 5000 })
  const entries = [{ kind: 0, exec: 0, name: 'x', childHash: hash, size: 1 }]
  // nonce 0 = an old holder that can't echo the request id → unverifiable, still accepted.
  proto._onTreeResponse(peer, { hash, entries, more: 0, nonce: 0 })
  t.alike(await p, entries, 'a lone frame from a pre-nonce holder still resolves')
})

test('FIX-357: pending tree requests are rejected promptly when the peer is torn down', async (t) => {
  const proto = new OverlayProtocolV2({}, {}, {})
  const hash = 'a1'.repeat(32)
  const peer = fakePeer()
  const p = proto.requestTree(peer, hash, { timeout: 60000 })
  const nonce = peer.pendingTrees.get(hash).nonce
  proto._onTreeResponse(peer, { hash, entries: [{ kind: 0, exec: 0, name: 'x', childHash: hash, size: 1 }], more: 1, nonce })
  t.ok(peer.pendingTrees.has(hash), 'buffered mid-stream')

  proto._failPendingTrees(peer, new Error('channel closed'))
  const err = await rejection(p)
  t.ok(err && /channel closed/.test(err.message), 'rejects on close, not after the 60s timeout')
  t.absent(peer.pendingTrees.has(hash), 'pending + buffer cleared on close')
})
