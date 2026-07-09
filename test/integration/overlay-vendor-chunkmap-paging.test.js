// [mirall] §4.11 — chunk-map paging. A very large file (e.g. 1.1 TB at tier 3,
// ~1M chunks) produces a chunk map that, stored as one Hyperbee value, exceeds
// Hypercore's 15 MiB MAX_SUGGESTED_BLOCK_SIZE and throws
// `BAD_ARGUMENT: Appended block exceeds the maximum suggested block size`,
// failing files:add after the whole-file read. FileIndex pages large maps
// across multiple values transparently; the public API is unchanged.
import test from 'brittle'
import { tmpStore } from './overlay-vendor-helpers.js'
import { FileIndex } from '../../src/shared/transfer/backends/overlay/vendor/file-index.js'

const HYPERCORE_MAX_BLOCK = 15 * 1024 * 1024

// Build a synthetic chunk map whose JSON encoding exceeds the Hypercore block
// limit, without needing a real multi-TB file. ~200k entries × ~116 B ≈ 23 MB.
function bigChunkMap (count) {
  const chunks = new Array(count)
  let offset = 0
  for (let i = 0; i < count; i++) {
    const length = 1048576
    chunks[i] = { hash: i.toString(16).padStart(64, '0'), offset, length }
    offset += length
  }
  return chunks
}

async function setup () {
  const store = tmpStore('chunkmap-paging')
  const index = new FileIndex(store)
  await index.ready()
  return index
}

test('REGRESSION (FIX-1): putChunkMap round-trips a map larger than the 15 MiB block limit', async (t) => {
  const index = await setup()
  const chunks = bigChunkMap(200000)
  t.ok(JSON.stringify(chunks).length > HYPERCORE_MAX_BLOCK, 'fixture exceeds the block limit')

  await index.putChunkMap('/mir/huge.bin', chunks) // threw BAD_ARGUMENT before paging
  const got = await index.getChunkMap('/mir/huge.bin')

  t.is(got.length, chunks.length, 'all chunks survive the round-trip')
  t.alike(got[0], chunks[0], 'first chunk intact')
  t.alike(got[got.length - 1], chunks[chunks.length - 1], 'last chunk intact')
  t.alike(got, chunks, 'full map deep-equal (order + every field)')
})

test('FIX-1: putChunkMapByHash round-trips a map larger than the block limit', async (t) => {
  const index = await setup()
  const chunks = bigChunkMap(200000)
  const oid = 'a'.repeat(64)

  await index.putChunkMapByHash(oid, chunks)
  const got = await index.getChunkMapByHash(oid)

  t.is(got.length, chunks.length, 'all chunks survive the round-trip')
  t.alike(got, chunks, 'full map deep-equal')
})

test('FIX-1: a small map is stored inline (no paging header) and round-trips', async (t) => {
  const index = await setup()
  const chunks = bigChunkMap(3)

  await index.putChunkMap('/mir/small.bin', chunks)

  const raw = await index.bee.get('chunkmap:/mir/small.bin')
  t.ok(Array.isArray(raw.value), 'small map stored as a plain array, not a paged header')
  t.alike(await index.getChunkMap('/mir/small.bin'), chunks, 'round-trips')
})

test('FIX-1: rewriting a paged map with a smaller one leaves no orphan pages', async (t) => {
  const index = await setup()
  await index.putChunkMap('/mir/shrink.bin', bigChunkMap(200000))
  const small = bigChunkMap(2)
  await index.putChunkMap('/mir/shrink.bin', small)

  t.alike(await index.getChunkMap('/mir/shrink.bin'), small, 'returns the new small map')

  let pageKeys = 0
  for await (const e of index.bee.createReadStream({ gte: 'chunkmap:/mir/shrink.bin', lt: 'chunkmap:/mir/shrink.bin\xff' })) {
    if (e.key.includes('\x00')) pageKeys++
  }
  t.is(pageKeys, 0, 'no orphan page keys remain')
})

test('FIX-1: deleting a paged map removes the header and every page', async (t) => {
  const index = await setup()
  await index.putChunkMap('/mir/del.bin', bigChunkMap(200000))
  await index.delChunkMap('/mir/del.bin')

  t.is(await index.getChunkMap('/mir/del.bin'), null, 'map gone')
  t.is(await index.hasChunkMap('/mir/del.bin'), false, 'hasChunkMap false')

  let leftover = 0
  for await (const e of index.bee.createReadStream({ gte: 'chunkmap:/mir/del.bin', lt: 'chunkmap:/mir/del.bin\xff' })) {
    leftover++
  }
  t.is(leftover, 0, 'no header or page keys remain')
})

test('FIX-1: a paged map missing a page reads as null (clean miss), never a truncated map', async (t) => {
  const index = await setup()
  const chunks = bigChunkMap(200000)
  await index.putChunkMap('/mir/corrupt.bin', chunks)
  // Simulate corruption: drop one interior page out from under the header.
  await index.bee.del('chunkmap:/mir/corrupt.bin\x001')

  const got = await index.getChunkMap('/mir/corrupt.bin')
  t.is(got, null, 'incomplete paged value returns null so the caller re-chunks — not a silently short array')
})
