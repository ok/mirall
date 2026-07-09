// Ported from hyper-overlay upstream test/chunker.test.js (6cac8ee). Body
// verbatim; only import paths retargeted to the vendored subset. See
// src/shared/transfer/backends/overlay/vendor/PROVENANCE.md.
import test from 'brittle'
import { chunk, hashChunk, MIN_SIZE, AVG_SIZE, MAX_SIZE, selectTier, getTierParams, TIERS } from '../../src/shared/transfer/backends/overlay/vendor/chunker.js'
import crypto from 'hypercore-crypto'

test('empty buffer produces zero chunks', (t) => {
  const result = chunk(Buffer.alloc(0))
  t.is(result.length, 0)
})

test('buffer smaller than MIN_SIZE produces one chunk', (t) => {
  const data = crypto.randomBytes(100)
  const result = chunk(data)
  t.is(result.length, 1)
  t.is(result[0].length, 100)
  t.is(result[0].offset, 0)
})

test('buffer exactly MIN_SIZE produces one chunk', (t) => {
  const data = crypto.randomBytes(MIN_SIZE)
  const result = chunk(data)
  t.is(result.length, 1)
  t.is(result[0].length, MIN_SIZE)
})

test('large buffer produces multiple chunks', (t) => {
  const data = crypto.randomBytes(256 * 1024) // 256KB
  const result = chunk(data)
  t.ok(result.length > 1, `got ${result.length} chunks`)

  // Verify all chunks are within size bounds
  for (const c of result) {
    // Last chunk can be smaller than MIN_SIZE
    if (c !== result[result.length - 1]) {
      t.ok(c.length >= MIN_SIZE, `chunk at ${c.offset} is ${c.length} bytes (min: ${MIN_SIZE})`)
    }
    t.ok(c.length <= MAX_SIZE, `chunk at ${c.offset} is ${c.length} bytes (max: ${MAX_SIZE})`)
  }
})

test('chunks cover entire buffer without gaps or overlap', (t) => {
  const data = crypto.randomBytes(128 * 1024) // 128KB
  const result = chunk(data)

  let totalBytes = 0
  let expectedOffset = 0
  for (const c of result) {
    t.is(c.offset, expectedOffset, `chunk offset matches`)
    expectedOffset += c.length
    totalBytes += c.length
  }
  t.is(totalBytes, data.length, 'total bytes matches input')
})

test('deterministic — same input always produces same chunks', (t) => {
  const data = crypto.randomBytes(64 * 1024)
  const result1 = chunk(data)
  const result2 = chunk(data)

  t.is(result1.length, result2.length, 'same chunk count')
  for (let i = 0; i < result1.length; i++) {
    t.is(result1[i].hash, result2[i].hash, `chunk ${i} hash matches`)
    t.is(result1[i].offset, result2[i].offset, `chunk ${i} offset matches`)
    t.is(result1[i].length, result2[i].length, `chunk ${i} length matches`)
  }
})

test('CDC stability — edit in middle changes only ~2 chunks', (t) => {
  const data = Buffer.alloc(128 * 1024)
  crypto.randomBytes(128 * 1024).copy(data)

  const original = chunk(data)

  // Edit 100 bytes in the middle
  const modified = Buffer.from(data)
  crypto.randomBytes(100).copy(modified, 64 * 1024)

  const edited = chunk(modified)

  // Count chunks with different hashes
  const origHashes = new Set(original.map(c => c.hash))
  const editHashes = new Set(edited.map(c => c.hash))

  let shared = 0
  for (const h of editHashes) {
    if (origHashes.has(h)) shared++
  }

  const changedChunks = edited.length - shared
  t.ok(changedChunks <= 4, `only ${changedChunks} chunks changed (expected ≤4)`)
  t.ok(shared > edited.length / 2, `${shared}/${edited.length} chunks shared`)
})

test('average chunk size approaches tier AVG_SIZE', (t) => {
  // 8MB (still Tier 1) so the sample holds ~128 chunks: with only ~16 chunks (the old
  // 1MB) CDC variance occasionally pushed the average past the 2x bound and flaked CI.
  const data = crypto.randomBytes(8 * 1024 * 1024)
  const tier = selectTier(data.length)
  const params = getTierParams(tier)
  const result = chunk(data)

  const avgSize = data.length / result.length
  // Allow 50% tolerance — CDC averages are approximate
  t.ok(avgSize > params.avgSize * 0.5, `avg ${avgSize} > ${params.avgSize * 0.5}`)
  t.ok(avgSize < params.avgSize * 2.0, `avg ${avgSize} < ${params.avgSize * 2.0}`)
})

// ── Adaptive tier tests ───────────────────────────────────────

test('selectTier returns correct tier for file sizes', (t) => {
  t.is(selectTier(100), 0, '100 bytes = tier 0')
  t.is(selectTier(500000), 0, '500KB = tier 0')
  t.is(selectTier(1048575), 0, 'just under 1MB = tier 0')
  t.is(selectTier(1048576), 1, 'exactly 1MB = tier 1')
  t.is(selectTier(50000000), 1, '50MB = tier 1')
  t.is(selectTier(104857600), 2, '100MB = tier 2')
  t.is(selectTier(5000000000), 2, '5GB = tier 2')
  t.is(selectTier(10737418240), 3, '10GB = tier 3')
  t.is(selectTier(200000000000), 3, '200GB = tier 3')
})

test('tier 0 uses small chunks', (t) => {
  const data = crypto.randomBytes(256 * 1024) // 256KB = tier 0
  const result = chunk(data)

  for (const c of result) {
    t.ok(c.length <= 65536, `chunk ${c.length} <= 64KB max`)
  }
})

test('tier 1 uses larger chunks', (t) => {
  const data = crypto.randomBytes(2 * 1024 * 1024) // 2MB = tier 1
  const result = chunk(data)

  // Tier 1: max 256KB. Should have fewer, larger chunks than tier 0
  for (const c of result) {
    t.ok(c.length <= 262144, `chunk ${c.length} <= 256KB max`)
  }
  // 2MB at ~64KB avg should produce ~30 chunks (not ~125 like tier 0 would)
  t.ok(result.length < 60, `${result.length} chunks (tier 1 should produce fewer than tier 0)`)
})

test('forced tier overrides auto-selection', (t) => {
  const data = crypto.randomBytes(2 * 1024 * 1024) // 2MB = auto tier 1

  const autoResult = chunk(data)
  const forcedResult = chunk(data, { tier: 0 })

  // Forcing tier 0 on a 2MB file should produce more, smaller chunks
  t.ok(forcedResult.length > autoResult.length,
    `tier 0 forced: ${forcedResult.length} chunks vs auto tier 1: ${autoResult.length}`)
})

test('same tier produces identical chunks', (t) => {
  const data = crypto.randomBytes(2 * 1024 * 1024)
  const a = chunk(data, { tier: 1 })
  const b = chunk(data, { tier: 1 })

  t.is(a.length, b.length)
  for (let i = 0; i < a.length; i++) {
    t.is(a[i].hash, b[i].hash, `chunk ${i} hash matches`)
  }
})

test('hashChunk produces consistent hex string', (t) => {
  const data = Buffer.from('hello world')
  const h1 = hashChunk(data)
  const h2 = hashChunk(data)
  t.is(h1, h2, 'same hash')
  t.is(h1.length, 64, '32 bytes = 64 hex chars')
  t.ok(/^[0-9a-f]{64}$/.test(h1), 'valid hex')
})

test('different data produces different hashes', (t) => {
  const h1 = hashChunk(Buffer.from('hello'))
  const h2 = hashChunk(Buffer.from('world'))
  t.not(h1, h2, 'different hashes')
})

import { Readable } from 'stream'
import { chunkStream, createStreamingHasher, chunkStats, setChunkStats } from '../../src/shared/transfer/backends/overlay/vendor/chunker.js'

function bufToStream (buf, partSize) {
  const parts = []
  for (let i = 0; i < buf.length; i += partSize) {
    parts.push(buf.subarray(i, Math.min(i + partSize, buf.length)))
  }
  return Readable.from(parts)
}

async function collect (asyncIter) {
  const out = []
  for await (const v of asyncIter) out.push(v)
  return out
}

test('chunkStream produces same chunk hashes as chunk() on same data', async (t) => {
  const data = crypto.randomBytes(2 * 1024 * 1024) // 2 MB → tier 1 boundary
  const tier = selectTier(data.length)
  const sync = chunk(data, { tier })
  const streamed = await collect(chunkStream(bufToStream(data, 8192), { tier }))

  t.is(streamed.length, sync.length, 'same chunk count')
  for (let i = 0; i < sync.length; i++) {
    t.is(streamed[i].hash, sync[i].hash, 'chunk ' + i + ' hash matches')
    t.is(streamed[i].offset, sync[i].offset, 'chunk ' + i + ' offset matches')
    t.is(streamed[i].length, sync[i].length, 'chunk ' + i + ' length matches')
  }
})

test('chunkStream is byte-exact for small files (< MIN_SIZE)', async (t) => {
  const data = crypto.randomBytes(1024)
  const out = await collect(chunkStream(bufToStream(data, 256), { tier: 0 }))
  t.is(out.length, 1, 'single chunk for sub-MIN_SIZE input')
  t.is(out[0].length, data.length)
  t.is(out[0].hash, hashChunk(data))
})

test('chunkStream chunk.data is independent of reader buffers', async (t) => {
  const data = crypto.randomBytes(64 * 1024)
  const out = await collect(chunkStream(bufToStream(data, 4096), { tier: 0 }))
  // verify each chunk's bytes match the original at its offset
  for (const c of out) {
    const expected = data.subarray(c.offset, c.offset + c.length)
    t.is(Buffer.compare(c.data, expected), 0, 'chunk bytes match source range')
  }
})

test('createStreamingHasher digest matches hashChunk when size is provided', (t) => {
  const data = crypto.randomBytes(123456)
  const ref = hashChunk(data)

  const h = createStreamingHasher({ size: data.length })
  // Feed in 8K slices to simulate a stream
  for (let i = 0; i < data.length; i += 8192) {
    h.update(data.subarray(i, Math.min(i + 8192, data.length)))
  }
  t.is(h.digest(), ref, 'streaming hash equals one-shot hash')
  t.is(h.bytes, data.length, 'byte counter matches input length')
})

test('createStreamingHasher without size produces a different (plain blake2b) digest', (t) => {
  const data = crypto.randomBytes(1024)
  const h = createStreamingHasher()
  h.update(data)
  const without = h.digest()
  const withSize = createStreamingHasher({ size: data.length })
  withSize.update(data)
  t.not(without, withSize.digest(), 'no-size digest differs from sized digest')
  t.not(without, hashChunk(data), 'no-size digest also differs from hashChunk')
})

// ── Phase 1/2: large-block reads + copy:false produce identical chunking ──

test('chunkStream is byte-exact vs chunk() across all tiers and block sizes', async (t) => {
  for (const tier of [0, 1, 2, 3]) {
    const { maxSize } = getTierParams(tier)
    const data = crypto.randomBytes(Math.max(maxSize * 3, 1024 * 1024))
    const ref = chunk(data, { tier })
    for (const block of [65536, maxSize, maxSize * 2]) {
      for (const copy of [true, false]) {
        const out = await collect(chunkStream(bufToStream(data, block), { tier, copy }))
        t.is(out.length, ref.length, `tier ${tier} block ${block} copy ${copy}: chunk count`)
        for (let i = 0; i < ref.length; i++) {
          t.is(out[i].hash, ref[i].hash, `t${tier} b${block} c${i} hash`)
          t.is(out[i].offset, ref[i].offset, `t${tier} b${block} c${i} offset`)
          t.is(out[i].length, ref[i].length, `t${tier} b${block} c${i} length`)
        }
      }
    }
  }
})

test('chunkStream copy:false yields correct chunk bytes', async (t) => {
  const data = crypto.randomBytes(3 * 1024 * 1024)
  const tier = selectTier(data.length)
  const parts = []
  for await (const c of chunkStream(bufToStream(data, getTierParams(tier).maxSize * 2), { tier, copy: false })) {
    parts.push(Buffer.from(c.data)) // a real consumer hashes synchronously; copy out to assert later
  }
  t.is(Buffer.compare(Buffer.concat(parts), data), 0, 'reassembled bytes equal original')
})

test('chunkStats: large blocks slash concat memcpy; copy:false zeroes copyBytes', async (t) => {
  const tier = 3 // maxSize 4 MiB — the tier where 64 KiB reads cause the ~56x blowup
  const { maxSize } = getTierParams(tier)
  const data = crypto.randomBytes(maxSize * 3)

  setChunkStats(true)
  await collect(chunkStream(bufToStream(data, 65536), { tier, copy: true }))
  const smallBlocks = { ...chunkStats }

  setChunkStats(true)
  await collect(chunkStream(bufToStream(data, maxSize * 2), { tier, copy: true }))
  const largeBlocks = { ...chunkStats }

  setChunkStats(true)
  await collect(chunkStream(bufToStream(data, maxSize * 2), { tier, copy: false }))
  const largeNoCopy = { ...chunkStats }
  setChunkStats(false)

  t.ok(smallBlocks.concatBytes > data.length * 10, `64 KiB reads amplify concat (${smallBlocks.concatBytes} > ${data.length * 10})`)
  t.ok(largeBlocks.concatBytes < data.length * 3, `large blocks collapse concat (${largeBlocks.concatBytes} < ${data.length * 3})`)
  t.ok(largeBlocks.copyBytes >= data.length, 'copy:true copies ~all bytes')
  t.is(largeNoCopy.copyBytes, 0, 'copy:false performs no per-chunk copy')
  t.ok(largeNoCopy.chunks > 1, 'multiple chunks produced')
})

test('chunkStream edge sizes match chunk() with large blocks', async (t) => {
  const tier = 1
  const { minSize, maxSize } = getTierParams(tier)
  for (const size of [0, 1, minSize, minSize + 1, maxSize, maxSize + 1, maxSize * 3]) {
    const data = crypto.randomBytes(size)
    const ref = chunk(data, { tier })
    const out = await collect(chunkStream(bufToStream(data, maxSize * 2), { tier, copy: false }))
    t.is(out.length, ref.length, `size ${size}: chunk count`)
    for (let i = 0; i < ref.length; i++) {
      t.is(out[i].hash, ref[i].hash, `size ${size} chunk ${i} hash`)
      t.is(out[i].length, ref[i].length, `size ${size} chunk ${i} length`)
    }
  }
})

test('createStreamingHasher — snapshot/restore resumes the digest exactly', (t) => {
  const a = crypto.randomBytes(100003)
  const b = crypto.randomBytes(99991)
  const size = a.length + b.length

  const oneShot = createStreamingHasher({ size })
  oneShot.update(a)
  oneShot.update(b)
  const expected = oneShot.digest()
  t.is(expected, hashChunk(Buffer.concat([a, b])), 'continuous digest == whole-file oid')

  const h1 = createStreamingHasher({ size })
  h1.update(a)
  const snap = h1.snapshot()
  t.is(snap.bytes, a.length, 'snapshot records consumed byte count')
  t.ok(snap.state.length > 0, 'snapshot carries the state buffer')

  h1.update(b)
  t.is(h1.digest(), expected, 'snapshot did not consume the original hasher')

  const h2 = createStreamingHasher({ size, restore: { state: snap.state, bytes: snap.bytes } })
  h2.update(b)
  t.is(h2.digest(), expected, 'restore + remaining bytes == continuous stream')
})
