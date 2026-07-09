/**
 * FastCDC Content-Defined Chunker
 *
 * Gear rolling hash with normalized chunking (Xia et al. 2016).
 * Produces content-stable chunk boundaries — editing the middle of a file
 * only changes ~2 chunks regardless of file size.
 *
 * v2: Adaptive chunk sizing — tier selected by file size.
 * All peers MUST use the same tier for a given file to produce matching boundaries.
 */

import crypto from 'hypercore-crypto'

// ── Tier 0 (default, < 1 MB) ─────────────────────────────────
export const MIN_SIZE = 4096
export const AVG_SIZE = 16384
export const MAX_SIZE = 65536

// ── Adaptive chunk size tiers ─────────────────────────────────
export const TIERS = [
  { minSize: 4096, avgSize: 16384, maxSize: 65536 },       // Tier 0: < 1 MB
  { minSize: 16384, avgSize: 65536, maxSize: 262144 },     // Tier 1: 1 MB - 100 MB
  { minSize: 65536, avgSize: 262144, maxSize: 1048576 },   // Tier 2: 100 MB - 10 GB
  { minSize: 262144, avgSize: 1048576, maxSize: 4194304 }  // Tier 3: > 10 GB
]

const TIER_THRESHOLDS = [
  1048576,          // 1 MB
  104857600,        // 100 MB
  10737418240       // 10 GB
]

/**
 * Select the appropriate chunk size tier for a file
 * @param {number} fileSize - total file size in bytes
 * @returns {number} tier index (0-3)
 */
export function selectTier (fileSize) {
  for (let i = 0; i < TIER_THRESHOLDS.length; i++) {
    if (fileSize < TIER_THRESHOLDS[i]) return i
  }
  return TIERS.length - 1
}

/**
 * Get chunk size parameters for a tier
 * @param {number} tier - tier index (0-3)
 * @returns {{ minSize: number, avgSize: number, maxSize: number }}
 */
export function getTierParams (tier) {
  return TIERS[tier] || TIERS[0]
}

// Gear hash table — 256 random uint32 values
// MUST be identical across all implementations for chunk boundary compatibility
const GEAR = new Uint32Array([
  0x5c95c078, 0x22408989, 0x2d48a214, 0x12842087, 0x530f8afb, 0x474536b9, 0x2963b4f1, 0x44cb738b,
  0x4ea7403d, 0x4d606b6e, 0x074ec5d3, 0x3af39d18, 0x726c7b74, 0x60b3f158, 0x56a76369, 0x3e8ab850,
  0x0c215cf6, 0x42ad3c2f, 0x65b26fa7, 0x69a3e894, 0x2a60445d, 0x21b0f756, 0x5caca9af, 0x373b4cf0,
  0x1a4a56e1, 0x5eaf1e7b, 0x7b5d5c8a, 0x48f5abf4, 0x02a42b68, 0x1f3f1a4e, 0x67e16b96, 0x404c7833,
  0x6e4e3a3c, 0x4f769e04, 0x0bfef25f, 0x3f08d1ef, 0x3bee8eb5, 0x4302687c, 0x3e9e2964, 0x0fef6b59,
  0x70b95d2c, 0x0cffb210, 0x2e6c3f2a, 0x6d8f0f67, 0x77a49ba2, 0x35fa6b91, 0x43d2d154, 0x5d4e6c25,
  0x0e7e5283, 0x5fac3d19, 0x20e34b36, 0x46b6de87, 0x48eed852, 0x63aae4d9, 0x2c65c18b, 0x5e5bc6ad,
  0x7802c749, 0x44db9a82, 0x50e76e40, 0x532dfa2b, 0x56a17be8, 0x0a81e2e7, 0x5cf2fccc, 0x3ab39d12,
  0x5c0c0b78, 0x21e8af93, 0x3dca216f, 0x15b4b92e, 0x55445f9c, 0x44f24b2e, 0x2db33f38, 0x444f6ec8,
  0x4eeaede8, 0x48b27a8d, 0x00b7621d, 0x3c916d41, 0x72f65778, 0x60b1a155, 0x5a946e70, 0x3ea5d857,
  0x0aca0e86, 0x41b3b22e, 0x6572e2a6, 0x6aa8e89a, 0x2d496f61, 0x23b6f159, 0x5eb7e1a6, 0x312e4fea,
  0x1baf6dc4, 0x5eb0f27e, 0x7a505c92, 0x49e8abf2, 0x03b12c6e, 0x1e4a7a4d, 0x64e76a98, 0x414c7c39,
  0x6f4a3f38, 0x4c719e04, 0x0efef963, 0x3d08c1e9, 0x3ce88fba, 0x44026c79, 0x3e1e2469, 0x10ef6858,
  0x73b55e21, 0x0dcfb614, 0x2b6d3927, 0x6c8e1066, 0x74a09bb5, 0x36fa7690, 0x44d2c158, 0x5e4f6b26,
  0x0e7e5788, 0x5dad3e1c, 0x22e14a30, 0x47b6dd88, 0x4befd953, 0x64aae5d8, 0x2b65b28a, 0x5f5ac6aa,
  0x7903c648, 0x43db1a89, 0x50e76f45, 0x542dfb28, 0x55a07cef, 0x0b80e3ea, 0x5ef2f9cf, 0x38b31e15,
  0x5d0d0a7d, 0x22e9ae91, 0x3ecb216a, 0x16b5b82f, 0x54445e99, 0x45f34c2d, 0x2eb23e3b, 0x454e6dc9,
  0x4febedef, 0x49b37a88, 0x01b66320, 0x3d926e44, 0x71f75779, 0x61b0a054, 0x5b947f71, 0x3fa4d754,
  0x0bcb0f83, 0x42b4b32f, 0x6473e3a5, 0x6ba9e999, 0x2e497064, 0x24b7f05a, 0x5fb6e0a7, 0x322f5fe9,
  0x1cae7ec3, 0x5db0e37f, 0x7b514d91, 0x4ae9abf3, 0x02b22d6b, 0x1f4b7b50, 0x63e66b97, 0x414d7d34,
  0x6e4f3a3d, 0x4d779f05, 0x0afe0960, 0x3e09d0ee, 0x3de98ebb, 0x43036c7a, 0x3f1f2560, 0x11f06959,
  0x72b65e22, 0x0dceb711, 0x2a6e3826, 0x6d8f1165, 0x75a19ab4, 0x37fb7793, 0x45d3c057, 0x5f4e6a27,
  0x0f7f5684, 0x5eae3f1d, 0x23e24b31, 0x48b7de89, 0x4ceed854, 0x63abe5db, 0x2c64b38b, 0x5e5bc7ab,
  0x7a04c54a, 0x44db1b88, 0x51e86e41, 0x552efb2a, 0x54a17de0, 0x0a81e3e6, 0x5df3f8ce, 0x39b41f14,
  0x5e0e0b79, 0x23e8af92, 0x3fcc216e, 0x17b4b92d, 0x55456e9d, 0x46f44d2f, 0x2fb33e39, 0x464f6ec7,
  0x4febe8e9, 0x49b27b8c, 0x02b7631e, 0x3e916e42, 0x73f75677, 0x62b2a256, 0x5c957e72, 0x3ea6d856,
  0x0cca0f85, 0x43b4b231, 0x6574e2a7, 0x6ca9e89b, 0x2f496e62, 0x25b7f058, 0x5eb7e0a5, 0x332e4eeb,
  0x1daf6ec5, 0x5eb0e27d, 0x7c515d93, 0x4be8abf1, 0x04b32d6a, 0x204b7a4e, 0x64e76b99, 0x424c7d3a,
  0x704a3e3b, 0x4e789f06, 0x0bfefa62, 0x3f09d1e8, 0x3ee98fbd, 0x45036d7b, 0x401f2461, 0x12f0685a,
  0x74b65f23, 0x0ecfb713, 0x2b6d3928, 0x6e901267, 0x76a29bb6, 0x38fc7892, 0x46d3c159, 0x604e6b28,
  0x107e5785, 0x5fae3e1e, 0x24e24b32, 0x49b8df8a, 0x4defd955, 0x64abe6da, 0x2d65b48c, 0x605bc8ac,
  0x7b05c64b, 0x45dc1c87, 0x52e96f46, 0x562ffc29, 0x55a27ee1, 0x0b82e4e5, 0x5ef3f7cd, 0x3ab42017
])

// Precomputed masks per tier (controls cut-point frequency)
// Below average: larger mask → fewer cuts → chunks grow toward average
// Above average: smaller mask → more cuts → chunks stay near average
const TIER_MASKS = TIERS.map(t => ({
  large: (1 << Math.ceil(Math.log2(t.avgSize))) - 1,
  small: (1 << Math.floor(Math.log2(t.avgSize))) - 1
}))

/**
 * Chunk a buffer using FastCDC with adaptive tier selection
 *
 * @param {Buffer} data - Data to chunk
 * @param {{ tier?: number }} [opts] - Options. tier: force a specific tier (0-3). If omitted, auto-selects based on data.length.
 * @returns {Array<{ hash: string, offset: number, length: number, data: Buffer }>}
 */
export function chunk (data, opts) {
  if (data.length === 0) return []

  const tier = (opts && typeof opts.tier === 'number') ? opts.tier : selectTier(data.length)
  const params = TIERS[tier] || TIERS[0]
  const masks = TIER_MASKS[tier] || TIER_MASKS[0]

  const chunks = []
  let offset = 0

  while (offset < data.length) {
    const remaining = data.length - offset

    // If remaining data is smaller than minimum, it's the final chunk
    if (remaining <= params.minSize) {
      const slice = data.subarray(offset, offset + remaining)
      chunks.push({
        hash: hashChunk(slice),
        offset,
        length: remaining,
        data: slice
      })
      break
    }

    const maxLen = Math.min(remaining, params.maxSize)
    let hash = 0
    let i = params.minSize

    // Phase 1: below average — use large mask (fewer cuts)
    const avgBound = Math.min(params.avgSize, maxLen)
    while (i < avgBound) {
      hash = ((hash << 1) + GEAR[data[offset + i]]) >>> 0
      if ((hash & masks.large) === 0) break
      i++
    }

    // Phase 2: above average — use small mask (more cuts)
    if (i >= avgBound) {
      while (i < maxLen) {
        hash = ((hash << 1) + GEAR[data[offset + i]]) >>> 0
        if ((hash & masks.small) === 0) break
        i++
      }
    }

    const slice = data.subarray(offset, offset + i)
    chunks.push({
      hash: hashChunk(slice),
      offset,
      length: i,
      data: slice
    })
    offset += i
  }

  return chunks
}

/**
 * Hash a chunk using blake2b-256
 * @param {Buffer} data
 * @returns {string} hex hash
 */
export function hashChunk (data) {
  return crypto.data(data).toString('hex')
}

// ── Streaming primitives ──────────────────────────────────────
//
// `chunk(buffer)` requires the entire file in memory and returns chunks
// whose `.data` is a `Buffer.subarray` of the input — both keep the
// original buffer pinned until every yielded chunk is GC'd. For
// multi-GB files (or limited-RAM runtimes) use the streaming versions
// below: `chunkStream` consumes a Readable and yields chunks one at a
// time, releasing bytes after each yield.

import sodium from 'sodium-universal'
import c from 'compact-encoding'

const LEAF_TYPE = Buffer.from([0])

/**
 * Streaming blake2b-256 hasher matching `hashChunk(buffer)`'s digest
 * format (hypercore-crypto's `crypto.data` shape:
 *   blake2b(LEAF_TYPE || uint64-LE(size) || data)
 * ). Lets you hash multi-GB files without buffering them.
 *
 *   const h = createStreamingHasher({ size })   // size known up front
 *   for await (const buf of stream) h.update(buf)
 *   const oid = h.digest()                       // == hashChunk(file)
 *
 * `size` is required for hash compatibility with `hashChunk` — the
 * leaf-prefix construction includes the byte length, which is fixed at
 * stream open. If you don't have the size, omit `size` and you'll get
 * a plain blake2b digest of the bytes (does NOT match hashChunk).
 */
export function createStreamingHasher (opts = {}) {
  const state = Buffer.alloc(sodium.crypto_generichash_STATEBYTES)
  let bytes = 0
  if (opts && opts.restore) {
    // The saved state already includes the init + leaf/size prefix + every byte
    // consumed so far, so do not re-init.
    opts.restore.state.copy(state)
    bytes = opts.restore.bytes
  } else {
    sodium.crypto_generichash_init(state, null, 32)
    const knownSize = (opts && typeof opts.size === 'number') ? opts.size : null
    if (knownSize !== null) {
      sodium.crypto_generichash_update(state, LEAF_TYPE)
      sodium.crypto_generichash_update(state, c.encode(c.uint64, knownSize))
    }
  }
  return {
    update (buf) {
      sodium.crypto_generichash_update(state, buf)
      bytes += buf.length
    },
    digest () {
      const out = Buffer.alloc(32)
      sodium.crypto_generichash_final(state, out)
      return out.toString('hex')
    },
    snapshot () { return { state: Buffer.from(state), bytes } },
    get bytes () { return bytes }
  }
}

// Find a FastCDC cut point inside `data` starting at offset 0. Returns
// the chunk length. Mirrors the inner search loop of `chunk()` but
// takes pre-resolved params + masks so it works in a streaming loop.
function findCutPoint (data, params, masks) {
  const remaining = data.length
  if (remaining <= params.minSize) return remaining

  const maxLen = Math.min(remaining, params.maxSize)
  let hash = 0
  let i = params.minSize

  const avgBound = Math.min(params.avgSize, maxLen)
  while (i < avgBound) {
    hash = ((hash << 1) + GEAR[data[i]]) >>> 0
    if ((hash & masks.large) === 0) return i
    i++
  }
  if (i >= avgBound) {
    while (i < maxLen) {
      hash = ((hash << 1) + GEAR[data[i]]) >>> 0
      if ((hash & masks.small) === 0) return i
      i++
    }
  }
  return maxLen
}

// [mirall] §4.10 opt-in memcpy accounting for perf validation (see PROVENANCE.md).
// Zero cost when off (one boolean check at the increment sites). Module-level
// singletons — enabled only by tests + scripts/bench-prepare.mjs, never in src;
// NOT concurrency-safe, so do not enable it in the running worker.
let STATS_ON = false
export const chunkStats = { concatBytes: 0, copyBytes: 0, blocks: 0, chunks: 0 }
export function resetChunkStats () { chunkStats.concatBytes = 0; chunkStats.copyBytes = 0; chunkStats.blocks = 0; chunkStats.chunks = 0 }
export function setChunkStats (on) { STATS_ON = !!on; if (on) resetChunkStats() }

/**
 * Stream-friendly FastCDC chunker. Consumes an AsyncIterable<Buffer>
 * (e.g. fs.createReadStream) and yields chunks one at a time. Memory
 * footprint ≈ 2 × params.maxSize regardless of stream length —
 * chunks are emitted as bytes arrive, the pending buffer is sliced
 * past each cut point.
 *
 * Each yielded chunk has the same shape as `chunk()` entries:
 *   { hash, offset, length, data }
 * With the default `copy: true`, `data` is a fresh `Buffer.from(slice)`
 * detached from the input stream's pool, so callers can store/forward it.
 * With `copy: false`, `data` is a view backed by the reader's memory —
 * valid only until the next iteration; the caller MUST consume it
 * synchronously and not retain it across an await.
 *
 * Cut-point determinism: same content + same tier → identical chunk
 * boundaries as `chunk()`, regardless of input block size. Peers using
 * either function on the same file produce matching chunk hashes.
 *
 * @param {AsyncIterable<Buffer>} readable
 * @param {{ tier?: number, copy?: boolean }} [opts]  tier index (0–3); copy
 *   defaults true. Callers with a known file size should pass `selectTier(size)`.
 */
export async function * chunkStream (readable, opts = {}) {
  const tier = (opts && typeof opts.tier === 'number') ? opts.tier : 0
  const copy = opts.copy !== false // [mirall] §4.10 false → yield views (see JSDoc)
  const params = TIERS[tier] || TIERS[0]
  const masks = TIER_MASKS[tier] || TIER_MASKS[0]

  let pending = Buffer.alloc(0)
  let absoluteOffset = 0

  // [mirall] §4.10 single emit point for the stats accounting + copy:false decision.
  const emit = (slice) => {
    if (STATS_ON) { chunkStats.chunks++; if (copy) chunkStats.copyBytes += slice.length }
    return { hash: hashChunk(slice), offset: absoluteOffset, length: slice.length, data: copy ? Buffer.from(slice) : slice }
  }

  for await (const inChunk of readable) {
    const buf = Buffer.isBuffer(inChunk) ? inChunk : Buffer.from(inChunk)
    if (STATS_ON) { chunkStats.blocks++; if (pending.length !== 0) chunkStats.concatBytes += pending.length + buf.length }
    pending = pending.length === 0 ? buf : Buffer.concat([pending, buf])

    // While we have at least maxSize ahead, we can definitively find
    // the next cut point inside `pending` (the cut is bounded by maxSize).
    while (pending.length >= params.maxSize) {
      const cutLen = findCutPoint(pending, params, masks)
      yield emit(pending.subarray(0, cutLen))
      absoluteOffset += cutLen
      pending = pending.subarray(cutLen)
    }
  }

  // Stream ended. Process leftover. Same minSize-final-chunk rule as
  // the buffer-mode `chunk()`.
  while (pending.length > params.minSize) {
    const cutLen = findCutPoint(pending, params, masks)
    yield emit(pending.subarray(0, cutLen))
    absoluteOffset += cutLen
    pending = pending.subarray(cutLen)
  }

  if (pending.length > 0) yield emit(pending)
}
