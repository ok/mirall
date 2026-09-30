// [mirall] §4.11 — chunk-map paging. A very large file (e.g. 1.1 TB at tier 3,
// ~1M chunks) produces a chunk map that, stored as one Hyperbee value, exceeds
// Hypercore's 15 MiB MAX_SUGGESTED_BLOCK_SIZE and throws
// `BAD_ARGUMENT: Appended block exceeds the maximum suggested block size`,
// failing files:add after the whole-file read. FileIndex pages large maps
// across multiple values transparently; the public API is unchanged.
import test from 'brittle'
import { tmpStore } from './overlay-engine-helpers.js'
import { FileIndex } from '../../src/shared/transfer/overlay/engine/store/file-index.js'

const HYPERCORE_MAX_BLOCK = 15 * 1024 * 1024

// Build a synthetic chunk map whose JSON encoding exceeds the Hypercore block
// limit, without needing a real multi-TB file. ~200k entries × ~116 B ≈ 23 MB.
function bigChunkMap(count) {
  const chunks = new Array(count)
  let offset = 0
  for (let i = 0; i < count; i++) {
    const length = 1048576
    chunks[i] = { hash: i.toString(16).padStart(64, '0'), offset, length }
    offset += length
  }
  return chunks
}

async function setup() {
  const store = tmpStore('chunkmap-paging')
  const index = new FileIndex(store)
  await index.ready()
  return index
}

const hashOf = (label) => Buffer.from(label).toString('hex').padEnd(64, '0')

test('REGRESSION (FIX-1): putChunkMapByHash round-trips a map larger than the 15 MiB block limit', async (t) => {
  const index = await setup()
  const chunks = bigChunkMap(200000)
  t.ok(JSON.stringify(chunks).length > HYPERCORE_MAX_BLOCK, 'fixture exceeds the block limit')

  await index.putChunkMapByHash(hashOf('huge'), chunks) // threw BAD_ARGUMENT before paging
  const got = await index.getChunkMapByHash(hashOf('huge'))

  t.is(got.length, chunks.length, 'all chunks survive the round-trip')
  t.alike(got[0], chunks[0], 'first chunk intact')
  t.alike(got[got.length - 1], chunks[chunks.length - 1], 'last chunk intact')
  t.alike(got, chunks, 'full map deep-equal (order + every field)')
})

test('FIX-1: a small map is stored inline (no paging header) and round-trips', async (t) => {
  const index = await setup()
  const chunks = bigChunkMap(3)

  await index.putChunkMapByHash(hashOf('small'), chunks)

  const raw = await index.bee.get('chunkmap-oid:' + hashOf('small'))
  t.ok(Array.isArray(raw.value), 'small map stored as a plain array, not a paged header')
  t.alike(await index.getChunkMapByHash(hashOf('small')), chunks, 'round-trips')
})

test('FIX-1: rewriting a paged map with a smaller one leaves no orphan pages', async (t) => {
  const index = await setup()
  await index.putChunkMapByHash(hashOf('shrink'), bigChunkMap(200000))
  const small = bigChunkMap(2)
  await index.putChunkMapByHash(hashOf('shrink'), small)

  t.alike(await index.getChunkMapByHash(hashOf('shrink')), small, 'returns the new small map')

  let pageKeys = 0
  for await (const e of index.bee.createReadStream({ gte: 'chunkmap-oid:' + hashOf('shrink'), lt: 'chunkmap-oid:' + hashOf('shrink') + '\xff' })) {
    if (e.key.includes('\x00')) pageKeys++
  }
  t.is(pageKeys, 0, 'no orphan page keys remain')
})

test('FIX-1: deleting a paged map removes the header and every page', async (t) => {
  const index = await setup()
  await index.putChunkMapByHash(hashOf('del'), bigChunkMap(200000))
  await index.delChunkMapByHash(hashOf('del'))

  t.is(await index.getChunkMapByHash(hashOf('del')), null, 'map gone')
  t.is(await index.hasChunkMapByHash(hashOf('del')), false, 'hasChunkMapByHash false')

  let leftover = 0
  for await (const _e of index.bee.createReadStream({ gte: 'chunkmap-oid:' + hashOf('del'), lt: 'chunkmap-oid:' + hashOf('del') + '\xff' })) {
    leftover++
  }
  t.is(leftover, 0, 'no header or page keys remain')
})

test('FIX-1: a paged map missing a page reads as null (clean miss), never a truncated map', async (t) => {
  const index = await setup()
  const chunks = bigChunkMap(200000)
  await index.putChunkMapByHash(hashOf('corrupt'), chunks)
  // Simulate corruption: drop one interior page out from under the header.
  await index.bee.del('chunkmap-oid:' + hashOf('corrupt') + '\x001')

  const got = await index.getChunkMapByHash(hashOf('corrupt'))
  t.is(got, null, 'incomplete paged value returns null so the caller re-chunks — not a silently short array')
})
