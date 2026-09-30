import test from 'brittle'
import { createChunkHashAssembler, sendChunkHashes, MAX_CHUNKS_PER_MSG, MAX_PAGED_ENTRIES_PER_PEER, MAX_PAGED_MAPS_PER_PEER } from '../../src/shared/transfer/overlay/engine/wire/paging.js'

const entry = (i) => ({ hash: String(i).padStart(64, '0'), length: 1 })
const page = (path, chunks, more = 1) => ({ path, tier: 0, chunks, more })
const noBound = () => null

test('a lone complete frame passes straight through without a copy', (t) => {
  const pages = createChunkHashAssembler()
  const chunks = [entry(0), entry(1)]
  t.is(pages.take({}, page('content:a', chunks, 0)), chunks)
})

test('pages reassemble in arrival order and the buffer clears on the last one', (t) => {
  const pages = createChunkHashAssembler()
  const peer = {}
  t.is(pages.take(peer, page('content:a', [entry(0)])), null)
  t.ok(pages.has(peer, 'content:a'))
  t.alike(pages.take(peer, page('content:a', [entry(1)], 0)), [entry(0), entry(1)])
  t.absent(pages.has(peer, 'content:a'))
})

test('interleaved paths on one peer reassemble independently', (t) => {
  const pages = createChunkHashAssembler()
  const peer = {}
  pages.take(peer, page('content:a', [entry(0)]))
  pages.take(peer, page('content:b', [entry(10)]))
  t.alike(pages.take(peer, page('content:a', [entry(1)], 0)), [entry(0), entry(1)])
  t.alike(pages.take(peer, page('content:b', [entry(11)], 0)), [entry(10), entry(11)])
})

test('drop discards one path; forget discards the peer', (t) => {
  const pages = createChunkHashAssembler()
  const peer = {}
  pages.take(peer, page('content:a', [entry(0)]))
  pages.take(peer, page('content:b', [entry(1)]))
  pages.drop(peer, 'content:a')
  t.absent(pages.has(peer, 'content:a'))
  t.ok(pages.has(peer, 'content:b'))
  pages.forget(peer)
  t.absent(pages.has(peer, 'content:b'))
  t.alike(pages.take(peer, page('content:b', [entry(2)], 0)), [entry(2)], 'a fresh answer starts clean')
})

test('overflow: a complete lone frame is never judged', (t) => {
  const pages = createChunkHashAssembler()
  let asked = false
  t.is(pages.overflow({}, page('content:a', [entry(0)], 0), () => { asked = true; return 0 }), null)
  t.absent(asked, 'the map bound is not even read')
})

test('overflow: past the map bound is "map", at it is fine', (t) => {
  const pages = createChunkHashAssembler()
  const peer = {}
  pages.take(peer, page('content:a', [entry(0), entry(1)]))
  t.is(pages.overflow(peer, page('content:a', [entry(2)]), () => 3), null, 'exactly at the bound')
  t.is(pages.overflow(peer, page('content:a', [entry(2), entry(3)]), () => 3), 'map', 'one past it')
})

test('overflow: a peer\'s entries are budgeted across all its maps', (t) => {
  const pages = createChunkHashAssembler()
  const peer = {}
  t.is(pages.overflow(peer, page('content:a', new Array(MAX_PAGED_ENTRIES_PER_PEER + 1).fill(entry(0))), noBound), 'peer', 'a first page alone can break it')
  pages.take(peer, page('content:a', new Array(MAX_PAGED_ENTRIES_PER_PEER - 1).fill(entry(0))))
  t.is(pages.overflow(peer, page('content:b', [entry(1)]), noBound), null, 'at the budget')
  t.is(pages.overflow(peer, page('content:b', [entry(1), entry(2)]), noBound), 'peer', 'one past it')
})

test('overflow: a peer holds at most MAX_PAGED_MAPS_PER_PEER maps', (t) => {
  const pages = createChunkHashAssembler()
  const peer = {}
  for (let i = 0; i < MAX_PAGED_MAPS_PER_PEER; i++) pages.take(peer, page('content:' + i, [entry(i)]))
  t.is(pages.overflow(peer, page('content:0', [entry(0)]), noBound), null, 'another page of a held map is fine')
  t.is(pages.overflow(peer, page('content:new', [entry(0)]), noBound), 'peer', 'one more map is not')
})

test('sendChunkHashes pages at MAX_CHUNKS_PER_MSG with more set on all but the last', (t) => {
  const sent = []
  const peer = { msgs: { chunkHashes: { send: (m) => sent.push(m) } } }
  const chunks = new Array(MAX_CHUNKS_PER_MSG * 2 + 5).fill(entry(0))
  sendChunkHashes(peer, 'content:big', 3, chunks)
  t.alike(sent.map((m) => [m.chunks.length, m.more]), [[MAX_CHUNKS_PER_MSG, 1], [MAX_CHUNKS_PER_MSG, 1], [5, 0]])
  t.ok(sent.every((m) => m.path === 'content:big' && m.tier === 3), 'every page names the path and tier')
})

test('sendChunkHashes ships a list that fits as one final frame', (t) => {
  const sent = []
  const chunks = [entry(0)]
  sendChunkHashes({ msgs: { chunkHashes: { send: (m) => sent.push(m) } } }, 'content:s', 0, chunks)
  t.alike(sent, [{ path: 'content:s', tier: 0, chunks, more: 0 }])
})
