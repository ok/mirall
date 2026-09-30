// SPDX-License-Identifier: AGPL-3.0-only
// Derived from hyper-overlay lib/file-index.js @ 6cac8ee (v0.2.9), Copyright (C) 2026 the
// hyper-overlay authors, licensed AGPL-3.0. Modified for Mirall in 2026; PROVENANCE.md
// lists the changes and carries the full license notice.

/**
 * FileIndex — chunk-map index backed by Hyperbee. Never stores file content; the
 * filesystem is the source of truth for actual bytes.
 *
 * Hyperbee schema:
 *   chunkmap-oid:<contentHash> → [{ hash, offset, length }] (small) | { __paged: N } (large; see below)
 *
 * Rows of other shapes may exist on stores written by older builds; nothing reads them and
 * compact() drops them.
 *
 * [mirall] §4.11 — chunk-map paging. A chunk map for a very large file (a 1.1 TB
 * file at tier 3 ≈ 1M entries ≈ ~120 MB of JSON) does not fit in one Hyperbee
 * value: Hypercore caps a block at 15 MiB (MAX_SUGGESTED_BLOCK_SIZE) and throws
 * BAD_ARGUMENT above it. Maps with > CHUNKS_PER_PAGE entries are stored as a
 * header value { __paged: N } at the base key plus N page values keyed
 * `<base>\x00<i>` (the NUL byte never occurs in a path or hex hash, so a page key
 * can't collide with a real one). Small maps stay inline as a plain array —
 * byte-identical to before, and back-compatible with already-stored maps. The
 * public API (put/get/del) is unchanged; paging is transparent to callers.
 */

import Hyperbee from 'hyperbee'
import ReadyResource from 'ready-resource'

// [mirall] §4.11 entries per chunk-map page. ~116 B/entry worst-case JSON ⇒
// ≤ ~3.8 MB/page, well under Hypercore's 15 MiB block limit.
const CHUNKS_PER_PAGE = 32768
// [mirall] resident-cost estimate charged to the injected chunk-map cache per decoded map: a
// 64-char one-byte hash string, a three-field object, an array slot, and headroom for heap
// numbers past 2 GiB offsets. Deliberately generous so the byte budget stays a bound.
const CHUNK_ENTRY_BYTES = 160
const CHUNK_MAP_BASE_BYTES = 64

// The one row kind anything reads: a content-addressed chunk map (`chunkmap-oid:<hash>`, its page
// keys folded in). compact() keeps those whose hash is still served and drops every other row —
// maps of hashes no longer served, and the rows older builds wrote, which nothing reads.
function servedHashOfKey (key) {
  if (!key.startsWith('chunkmap-oid:')) return null
  return key.slice('chunkmap-oid:'.length).split('\x00')[0]
}

function keepOnCompact (key, isServed) {
  const hash = servedHashOfKey(key)
  return hash !== null && isServed(hash)
}

// v1 keeps the original 'file-index' name so existing stores aren't orphaned on
// upgrade; compaction moves to file-index-v2, v3, … and purges the predecessor.
export function indexCoreName (version) {
  return version === 1 ? 'file-index' : `file-index-v${version}`
}

export class FileIndex extends ReadyResource {
  constructor (store, opts = {}) {
    super()
    this._store = store
    this._bee = null
    this._meta = null
    this._version = 1
    this._opts = opts
    // [mirall] host-injected cache of DECODED chunk maps, keyed by bee key. Absent -> every
    // read decodes from the bee, as upstream. `_mutations` fences a decode that was in flight
    // across a write of the same key so it can never cache the pre-write value.
    this._chunkMapCache = opts.chunkMapCache || null
    this._mutations = 0
  }

  // [mirall] Local index cores are encrypted at rest under an M-derived key
  // (store.js overlayIndexEncryptionKey). Absent (insecure/test mode) ⇒ plaintext.
  _coreOpts (name) {
    const o = { name, valueEncoding: 'binary' }
    if (this._opts.encryptionKey) o.encryptionKey = this._opts.encryptionKey
    return o
  }

  async _open () {
    this._meta = new Hyperbee(this._store.get(this._coreOpts('index-meta')), {
      keyEncoding: 'utf-8',
      valueEncoding: 'json',
      alwaysDuplicate: false
    })
    await this._meta.ready()
    this._version = (await this._meta.get('version'))?.value ?? 1
    // A prior purge can leave a version's core with a dangling name alias — its data and
    // by-discovery-key alias were deleted but the by-name alias was not — which throws
    // STORAGE_EMPTY on open. The index is rebuildable cache, so advance to a fresh core
    // name and record it rather than failing worker boot.
    for (let attempts = 0; ; attempts++) {
      const bee = new Hyperbee(this._store.get(this._coreOpts(indexCoreName(this._version))), {
        keyEncoding: 'utf-8',
        valueEncoding: 'json',
        alwaysDuplicate: false
      })
      try {
        await bee.ready()
        this._bee = bee
        return
      } catch (err) {
        if (err.code !== 'STORAGE_EMPTY' || attempts >= 64) throw err
        await bee.close().catch(() => {})
        this._version += 1
        await this._meta.put('version', this._version)
      }
    }
  }

  async _close () {
    if (this._chunkMapCache) this._chunkMapCache.clear()
    if (this._bee) await this._bee.close()
    if (this._meta) await this._meta.close()
  }

  get bee () { return this._bee }

  get version () { return this._version }

  get cores () { return [this._bee?.core, this._meta?.core].filter(Boolean) }

  // Reclaim the append-only index: stream the rows worth keeping into a fresh versioned core, flip
  // the version pointer, and return the old core so the caller can clear+purge it (the only way to
  // return an append-only bee's disk to the OS).
  async compact ({ isServed }) {
    const dropped = (key) => !keepOnCompact(key, isServed)
    // Skip the rewrite entirely when nothing is droppable — otherwise a compaction of
    // an already-clean index just churns (a fresh version core + a version-marker
    // append), which grows the index without reclaiming anything.
    let droppable = false
    for await (const { key } of this._bee.createReadStream()) {
      if (dropped(key)) { droppable = true; break }
    }
    if (!droppable) return null

    const next = this._version + 1
    const dst = new Hyperbee(this._store.get(this._coreOpts(indexCoreName(next))), {
      keyEncoding: 'utf-8',
      valueEncoding: 'json',
      alwaysDuplicate: false
    })
    await dst.ready()
    let batch = dst.batch()
    let pending = 0
    for await (const { key, value } of this._bee.createReadStream()) {
      if (dropped(key)) continue
      await batch.put(key, value)
      if (++pending >= 500) { await batch.flush(); batch = dst.batch(); pending = 0 }
    }
    await batch.flush()

    const oldCore = this._bee.core
    await this._meta.put('version', next)
    this._bee = dst
    this._version = next
    // [mirall] the dropped hashes' maps must not survive in memory; the kept ones re-warm on
    // first use.
    this._mutations++
    if (this._chunkMapCache) this._chunkMapCache.clear()
    return oldCore // left open; caller clears + purges it
  }

  // [mirall] §4.11 paged-value storage. Small maps stay inline as a plain array
  // (unchanged on disk, back-compatible); maps over CHUNKS_PER_PAGE entries are
  // split into a { __paged: N } header + N `<base>\x00<i>` page values, written
  // in one Hyperbee batch so the whole map commits atomically. Stale pages from
  // a previously-larger map at the same key are deleted in the same batch.
  async _putPagedValue (baseKey, chunks) {
    try { await this._writePagedValue(baseKey, chunks) } finally { this._invalidateChunkMap(baseKey) }
  }

  // [mirall] AFTER any write to a chunk-map key: move the fence so an in-flight decode will not
  // cache what it read, then drop the cached value. After, not before: a decode that starts
  // between an early bump and the write would otherwise cache the pre-write value.
  _invalidateChunkMap (baseKey) {
    this._mutations++
    if (this._chunkMapCache) this._chunkMapCache.delete(baseKey)
  }

  async _writePagedValue (baseKey, chunks) {
    const prevPages = await this._pagedCount(baseKey)

    if (chunks.length <= CHUNKS_PER_PAGE) {
      if (prevPages === 0) {
        await this._bee.put(baseKey, chunks)
        return
      }
      await this._batched(async (b) => {
        await b.put(baseKey, chunks)
        for (let i = 0; i < prevPages; i++) await b.del(`${baseKey}\x00${i}`)
      })
      return
    }

    const pageCount = Math.ceil(chunks.length / CHUNKS_PER_PAGE)
    await this._batched(async (b) => {
      await b.put(baseKey, { __paged: pageCount })
      for (let i = 0; i < pageCount; i++) {
        await b.put(`${baseKey}\x00${i}`, chunks.slice(i * CHUNKS_PER_PAGE, (i + 1) * CHUNKS_PER_PAGE))
      }
      for (let i = pageCount; i < prevPages; i++) await b.del(`${baseKey}\x00${i}`)
    })
  }

  // [mirall] consult the injected cache first; on a miss decode from the bee and cache the
  // result unless a write to this key landed while the decode was in flight.
  async _getPagedValue (baseKey) {
    const cache = this._chunkMapCache
    const hit = cache ? cache.get(baseKey) : undefined
    if (hit) return hit
    const fence = this._mutations
    const chunks = await this._decodePagedValue(baseKey)
    if (chunks && cache && fence === this._mutations) {
      cache.set(baseKey, chunks, CHUNK_MAP_BASE_BYTES + chunks.length * CHUNK_ENTRY_BYTES)
    }
    return chunks
  }

  // The pre-cache read, unchanged (was _getPagedValue).
  async _decodePagedValue (baseKey) {
    const entry = await this._bee.get(baseKey)
    if (!entry) return null
    if (Array.isArray(entry.value)) return entry.value // inline / legacy
    const pageCount = entry.value.__paged
    if (!pageCount) return null
    const chunks = []
    for (let i = 0; i < pageCount; i++) {
      const page = await this._bee.get(`${baseKey}\x00${i}`)
      // The header + all pages commit in one atomic batch, so a missing or non-array
      // page means the value is corrupt/incomplete. Return null — a clean "miss" so the
      // caller re-chunks from the source file — never a silently truncated chunk map.
      if (!page || !Array.isArray(page.value)) return null
      for (const c of page.value) chunks.push(c)
    }
    return chunks
  }

  async _delPagedValue (baseKey) {
    try { await this._erasePagedValue(baseKey) } finally { this._invalidateChunkMap(baseKey) }
  }

  async _erasePagedValue (baseKey) {
    const prevPages = await this._pagedCount(baseKey)
    if (prevPages === 0) {
      await this._bee.del(baseKey)
      return
    }
    await this._batched(async (b) => {
      await b.del(baseKey)
      for (let i = 0; i < prevPages; i++) await b.del(`${baseKey}\x00${i}`)
    })
  }

  // Page count of an existing paged value, or 0 if the key is absent or inline.
  async _pagedCount (baseKey) {
    const entry = await this._bee.get(baseKey)
    if (!entry || Array.isArray(entry.value)) return 0
    return entry.value.__paged || 0
  }

  // Run ops in a Hyperbee batch, closing it on error (flush releases the lock
  // itself, even on append failure, via _appendBatch's finally).
  async _batched (fn) {
    const b = this._bee.batch()
    try {
      await fn(b)
      await b.flush()
    } catch (err) {
      try { await b.close() } catch {}
      throw err
    }
  }

  // [mirall] Content-addressed chunk map. FastCDC is deterministic on bytes, so a
  // given content hash always chunks identically regardless of which overlay path
  // it was registered under. Keying by content hash lets the publish-time chunking
  // be reused at serve time (a synthetic 'content:<hash>' key) and across restarts,
  // instead of re-reading the whole file to re-chunk it before the first byte ships.
  async putChunkMapByHash (contentHash, chunks) {
    await this._putPagedValue(`chunkmap-oid:${contentHash}`, chunks)
  }

  async getChunkMapByHash (contentHash) {
    return this._getPagedValue(`chunkmap-oid:${contentHash}`)
  }

  async hasChunkMapByHash (contentHash) {
    return (await this._bee.get(`chunkmap-oid:${contentHash}`)) !== null
  }

  async delChunkMapByHash (contentHash) {
    await this._delPagedValue(`chunkmap-oid:${contentHash}`)
  }

  // Drop the served hash's chunk map.
  async evictContent (contentHash) {
    await this.delChunkMapByHash(contentHash)
  }
}
