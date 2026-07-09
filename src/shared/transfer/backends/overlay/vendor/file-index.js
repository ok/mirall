/**
 * FileIndex — Metadata-only file index backed by Hyperbee
 *
 * Stores file metadata and chunk maps. Never stores file content.
 * The filesystem is the source of truth for actual bytes.
 *
 * Hyperbee schema:
 *   file:<path>                → { contentHash, size, mtime, hashing, executable, linkname }
 *   chunkmap:<path>            → [{ hash, offset, length }]  (small) | { __paged: N } (large; see below)
 *   chunkmap-oid:<contentHash> → [{ hash, offset, length }]   (content-addressed; reused across overlay keys + restarts)
 *   sync:<peerKey>:<path>      → { lastSeq, lastHash }
 *   config:sync                → { folders: [...] }
 *
 *   tree:<hex-hash>            → { entries: [{kind, exec, name, childHash, size}], size }
 *   treepath:<path>            → <hex-hash>   (secondary: path → current tree hash)
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

// The content hash an owner-side entry is addressed by (page suffix folded in), or
// null for entries not keyed by a single content hash (real-path file:/chunkmap:,
// tree:, sync:, config:). compact() drops the content-addressed entries whose hash is
// no longer served, and keeps everything else.
function contentHashOfKey (key) {
  if (key.startsWith('chunkmap-oid:')) return key.slice('chunkmap-oid:'.length).split('\x00')[0]
  if (key.startsWith('chunkmap:content:')) return key.slice('chunkmap:content:'.length).split('\x00')[0]
  if (key.startsWith('chunkmap:/mir/')) return key.slice('chunkmap:/mir/'.length).split('\x00')[0]
  if (key.startsWith('file:/mir/')) return key.slice('file:/mir/'.length)
  return null
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
      valueEncoding: 'json'
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
        valueEncoding: 'json'
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
    if (this._bee) await this._bee.close()
    if (this._meta) await this._meta.close()
  }

  get bee () { return this._bee }

  get version () { return this._version }

  get cores () { return [this._bee?.core, this._meta?.core].filter(Boolean) }

  // Reclaim the append-only index: stream the still-served entries into a fresh
  // versioned core, flip the version pointer, and return the old core so the caller
  // can clear+purge it (the only way to return an append-only bee's disk to the OS).
  // Content-addressed entries (maps + /mir register) whose hash isServed() is false
  // are dropped; real-path, tree, sync and config entries are always kept.
  async compact ({ isServed }) {
    // Skip the rewrite entirely when nothing is droppable — otherwise a compaction of
    // an already-clean index just churns (a fresh version core + a version-marker
    // append), which grows the index without reclaiming anything.
    let droppable = false
    for await (const { key } of this._bee.createReadStream()) {
      const hash = contentHashOfKey(key)
      if (hash !== null && !isServed(hash)) { droppable = true; break }
    }
    if (!droppable) return null

    const next = this._version + 1
    const dst = new Hyperbee(this._store.get(this._coreOpts(indexCoreName(next))), {
      keyEncoding: 'utf-8',
      valueEncoding: 'json'
    })
    await dst.ready()
    let batch = dst.batch()
    let pending = 0
    for await (const { key, value } of this._bee.createReadStream()) {
      const hash = contentHashOfKey(key)
      if (hash !== null && !isServed(hash)) continue
      await batch.put(key, value)
      if (++pending >= 500) { await batch.flush(); batch = dst.batch(); pending = 0 }
    }
    await batch.flush()

    const oldCore = this._bee.core
    await this._meta.put('version', next)
    this._bee = dst
    this._version = next
    return oldCore // left open; caller clears + purges it
  }

  // ── File entries ────────────────────────────────────────────

  /**
   * Store or update a file entry (metadata only, no content)
   * @param {string} path - file path
   * @param {{ contentHash: string|null, size: number, mtime: number, hashing?: boolean, executable?: boolean, linkname?: string|null }} meta
   */
  async putFile (path, meta) {
    await this._bee.put(`file:${path}`, {
      contentHash: meta.contentHash || null,
      size: meta.size,
      mtime: meta.mtime,
      hashing: meta.hashing || false,
      executable: meta.executable || false,
      linkname: meta.linkname || null
    })
  }

  /**
   * Get file metadata
   * @param {string} path
   * @returns {{ contentHash: string|null, size: number, mtime: number, hashing: boolean, executable: boolean, linkname: string|null } | null}
   */
  async getFile (path) {
    const entry = await this._bee.get(`file:${path}`)
    return entry ? entry.value : null
  }

  /**
   * Check if file exists in the index
   * @param {string} path
   * @returns {boolean}
   */
  async hasFile (path) {
    const entry = await this._bee.get(`file:${path}`)
    return entry !== null
  }

  /**
   * Remove a file entry and its chunk map
   * @param {string} path
   */
  async delFile (path) {
    await this._bee.del(`file:${path}`)
    await this._delPagedValue(`chunkmap:${path}`)
  }

  /**
   * List files under a directory prefix
   * @param {string} [dir=''] - directory prefix
   * @returns {Array<{ path: string, contentHash: string|null, size: number, mtime: number }>}
   */
  async listFiles (dir = '') {
    const prefix = dir ? `file:${dir}` : 'file:'
    const files = []

    for await (const entry of this._bee.createReadStream({ gt: prefix, lt: prefix + '\xff' })) {
      files.push({
        path: entry.key.slice('file:'.length),
        ...entry.value
      })
    }

    return files
  }

  // ── Chunk maps ──────────────────────────────────────────────

  /**
   * Store a chunk map for a file (hash + offset + length per chunk, no data).
   * Large maps are paged transparently (see §4.11) so they never exceed the
   * Hypercore block limit.
   * @param {string} path - file path
   * @param {Array<{ hash: string, offset: number, length: number }>} chunks
   */
  async putChunkMap (path, chunks) {
    await this._putPagedValue(`chunkmap:${path}`, chunks)
  }

  /**
   * Get the chunk map for a file
   * @param {string} path
   * @returns {Array<{ hash: string, offset: number, length: number }> | null}
   */
  async getChunkMap (path) {
    return this._getPagedValue(`chunkmap:${path}`)
  }

  /**
   * Check if a chunk map exists for a file
   * @param {string} path
   * @returns {boolean}
   */
  async hasChunkMap (path) {
    const entry = await this._bee.get(`chunkmap:${path}`)
    return entry !== null
  }

  /**
   * Remove a chunk map
   * @param {string} path
   */
  async delChunkMap (path) {
    await this._delPagedValue(`chunkmap:${path}`)
  }

  // [mirall] §4.11 paged-value storage. Small maps stay inline as a plain array
  // (unchanged on disk, back-compatible); maps over CHUNKS_PER_PAGE entries are
  // split into a { __paged: N } header + N `<base>\x00<i>` page values, written
  // in one Hyperbee batch so the whole map commits atomically. Stale pages from
  // a previously-larger map at the same key are deleted in the same batch.
  async _putPagedValue (baseKey, chunks) {
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

  async _getPagedValue (baseKey) {
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

  // Evict every durable entry a served content hash leaves behind: the content-
  // addressed map plus the deterministic owner-side synthetic paths (the serve
  // copy at content:<hash> and the register entry at /mir/<hash>). Peer-path-keyed
  // receiver entries are unknowable from the hash — the file-index sweep handles those.
  async evictContent (contentHash) {
    await this.delChunkMapByHash(contentHash)
    await this.delChunkMap(`content:${contentHash}`)
    await this.delFile(`/mir/${contentHash}`)
  }

  // ── Sync state ──────────────────────────────────────────────

  /**
   * Store sync state for a peer + file
   * @param {string} peerKey - hex peer key
   * @param {string} path - file path
   * @param {{ lastSeq: number, lastHash: string }} state
   */
  async putSyncState (peerKey, path, state) {
    await this._bee.put(`sync:${peerKey}:${path}`, {
      lastSeq: state.lastSeq,
      lastHash: state.lastHash
    })
  }

  /**
   * Get sync state for a peer + file
   * @param {string} peerKey
   * @param {string} path
   * @returns {{ lastSeq: number, lastHash: string } | null}
   */
  async getSyncState (peerKey, path) {
    const entry = await this._bee.get(`sync:${peerKey}:${path}`)
    return entry ? entry.value : null
  }

  /**
   * Remove sync state for a peer + file
   * @param {string} peerKey
   * @param {string} path
   */
  async delSyncState (peerKey, path) {
    await this._bee.del(`sync:${peerKey}:${path}`)
  }

  /**
   * List all sync states for a peer
   * @param {string} peerKey
   * @returns {Array<{ path: string, lastSeq: number, lastHash: string }>}
   */
  async listSyncStates (peerKey) {
    const prefix = `sync:${peerKey}:`
    const states = []

    for await (const entry of this._bee.createReadStream({ gt: prefix, lt: prefix + '\xff' })) {
      states.push({
        path: entry.key.slice(prefix.length),
        ...entry.value
      })
    }

    return states
  }

  // ── Sync config ─────────────────────────────────────────────

  /**
   * Store sync configuration
   * @param {{ folders: Array<{ path: string, strategy: string, quota?: string|null, peers?: string[] }> }} config
   */
  async putSyncConfig (config) {
    await this._bee.put('config:sync', config)
  }

  /**
   * Get sync configuration
   * @returns {{ folders: Array } | null}
   */
  async getSyncConfig () {
    const entry = await this._bee.get('config:sync')
    return entry ? entry.value : null
  }

  // ── Trees ───────────────────────────────────────────────────

  /**
   * Store a tree by its content-addressed hash.
   * Same hash put twice is a no-op (content-addressed — bytes can't differ).
   *
   * @param {string} hash - hex-encoded blake2b-256 tree hash
   * @param {{ entries: Array, size: number }} tree
   */
  async putTree (hash, tree) {
    await this._bee.put(`tree:${hash}`, {
      entries: tree.entries,
      size: tree.size
    })
  }

  /**
   * Get a tree by its hash.
   * @param {string} hash
   * @returns {{ entries: Array, size: number } | null}
   */
  async getTree (hash) {
    const entry = await this._bee.get(`tree:${hash}`)
    return entry ? entry.value : null
  }

  /**
   * Check if a tree is present.
   * @param {string} hash
   * @returns {boolean}
   */
  async hasTree (hash) {
    const entry = await this._bee.get(`tree:${hash}`)
    return entry !== null
  }

  /**
   * Remove a tree. Only safe when no treepath entries reference this hash.
   * @param {string} hash
   */
  async delTree (hash) {
    await this._bee.del(`tree:${hash}`)
  }

  /**
   * Record the current tree hash for a path (secondary index).
   * @param {string} path
   * @param {string} hash
   */
  async putTreePath (path, hash) {
    await this._bee.put(`treepath:${path}`, hash)
  }

  /**
   * Look up the current tree hash for a path.
   * @param {string} path
   * @returns {string|null}
   */
  async getTreePath (path) {
    const entry = await this._bee.get(`treepath:${path}`)
    return entry ? entry.value : null
  }

  /**
   * Remove the treepath entry. Does NOT delete the underlying tree — other
   * paths may still reference the same hash.
   * @param {string} path
   */
  async delTreePath (path) {
    await this._bee.del(`treepath:${path}`)
  }

  /**
   * List all stored tree hashes.
   * @param {object} [opts]
   * @param {number} [opts.limit] - optional cap
   * @returns {Array<{ hash: string, entryCount: number, size: number }>}
   */
  async listTrees (opts = {}) {
    const trees = []
    for await (const entry of this._bee.createReadStream({ gt: 'tree:', lt: 'tree:\xff' })) {
      trees.push({
        hash: entry.key.slice('tree:'.length),
        entryCount: entry.value.entries.length,
        size: entry.value.size
      })
      if (opts.limit && trees.length >= opts.limit) break
    }
    return trees
  }

  // ── Stats ───────────────────────────────────────────────────

  /**
   * Get index statistics
   * @returns {{ fileCount: number, chunkMapCount: number, syncStateCount: number, treeCount: number, treePathCount: number }}
   */
  async stats () {
    let fileCount = 0
    let chunkMapCount = 0
    let syncStateCount = 0
    let treeCount = 0
    let treePathCount = 0

    for await (const entry of this._bee.createReadStream()) {
      if (entry.key.startsWith('file:')) fileCount++
      // [mirall] §4.11 count one per file — skip the `\x00`-suffixed page values.
      else if (entry.key.startsWith('chunkmap:') && !entry.key.includes('\x00')) chunkMapCount++
      else if (entry.key.startsWith('sync:')) syncStateCount++
      else if (entry.key.startsWith('tree:')) treeCount++
      else if (entry.key.startsWith('treepath:')) treePathCount++
    }

    return { fileCount, chunkMapCount, syncStateCount, treeCount, treePathCount }
  }
}
