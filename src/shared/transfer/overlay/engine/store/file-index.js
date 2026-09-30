// SPDX-License-Identifier: AGPL-3.0-only
// Derived from hyper-overlay lib/file-index.js @ 6cac8ee (v0.2.9), Copyright (C) 2026 the
// hyper-overlay authors, licensed AGPL-3.0. Modified for Mirall in 2026; PROVENANCE.md
// lists the changes and carries the full license notice.

// FileIndex — the chunk-map index, backed by Hyperbee. It never stores file content; the
// filesystem is the source of truth for bytes. Its one row kind is
//   chunkmap-oid:<contentHash> → [{ hash, offset, length }], paged when large (paged-values.js)
// Rows of other shapes may exist on stores written by older builds; nothing reads them and
// compact() drops them.

import Hyperbee from 'hyperbee'
import ReadyResource from 'ready-resource'
import { PagedValues } from './paged-values.js'

const mapKey = (contentHash) => 'chunkmap-oid:' + contentHash

// compact() keeps a content-addressed map (its page keys folded in) whose hash is still served,
// and drops every other row.
function keepOnCompact(key, isServed) {
  if (!key.startsWith('chunkmap-oid:')) return false
  return isServed(key.slice('chunkmap-oid:'.length).split('\x00')[0])
}

// v1 keeps the original 'file-index' name so existing stores aren't orphaned on upgrade;
// compaction moves to file-index-v2, v3, … and purges the predecessor.
export function indexCoreName(version) {
  return version === 1 ? 'file-index' : `file-index-v${version}`
}

export class FileIndex extends ReadyResource {
  // opts.encryptionKey encrypts the local cores at rest (absent: plaintext); opts.chunkMapCache
  // caches decoded maps (absent: every read decodes from the bee).
  constructor(store, opts = {}) {
    super()
    this._store = store
    this._bee = null
    this._meta = null
    this._version = 1
    this._encryptionKey = opts.encryptionKey || null
    this._maps = new PagedValues({ bee: () => this._bee, cache: opts.chunkMapCache || null })
  }

  _openBee(name) {
    const core = { name, valueEncoding: 'binary' }
    if (this._encryptionKey) core.encryptionKey = this._encryptionKey
    return new Hyperbee(this._store.get(core), { keyEncoding: 'utf-8', valueEncoding: 'json', alwaysDuplicate: false })
  }

  // A prior purge can leave a version's core with a dangling name alias (its data gone, the alias
  // kept), which throws STORAGE_EMPTY on open. The index is a rebuildable cache, so it advances to a
  // fresh core name and records it rather than failing boot.
  async _open() {
    this._meta = this._openBee('index-meta')
    await this._meta.ready()
    this._version = (await this._meta.get('version'))?.value ?? 1
    for (let attempts = 0; ; attempts++) {
      const bee = this._openBee(indexCoreName(this._version))
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

  async _close() {
    this._maps.clear()
    if (this._bee) await this._bee.close()
    if (this._meta) await this._meta.close()
  }

  get bee() { return this._bee }

  get version() { return this._version }

  get cores() { return [this._bee?.core, this._meta?.core].filter(Boolean) }

  // Reclaim the append-only index: stream the rows worth keeping into a fresh versioned core, flip
  // the version pointer, and return the old core, left open, so the caller can clear and purge it
  // (the only way to hand an append-only bee's disk back to the OS). An index with nothing to drop
  // is left alone, since a rewrite would only grow it.
  async compact({ isServed }) {
    let droppable = false
    for await (const { key } of this._bee.createReadStream()) {
      if (!keepOnCompact(key, isServed)) { droppable = true; break }
    }
    if (!droppable) return null
    const next = this._version + 1
    const dst = this._openBee(indexCoreName(next))
    await dst.ready()
    let batch = dst.batch()
    let pending = 0
    for await (const { key, value } of this._bee.createReadStream()) {
      if (!keepOnCompact(key, isServed)) continue
      await batch.put(key, value)
      if (++pending >= 500) { await batch.flush(); batch = dst.batch(); pending = 0 }
    }
    await batch.flush()
    const oldCore = this._bee.core
    await this._meta.put('version', next)
    this._bee = dst
    this._version = next
    // The dropped hashes' maps must not survive in memory; the kept ones re-warm on first use.
    this._maps.invalidateAll()
    return oldCore
  }

  // Keyed by content hash: FastCDC is deterministic on bytes, so a hash always chunks identically
  // and a map computed at publish serves every later request and survives restarts.
  putChunkMapByHash(contentHash, chunks) { return this._maps.put(mapKey(contentHash), chunks) }

  getChunkMapByHash(contentHash) { return this._maps.get(mapKey(contentHash)) }

  async hasChunkMapByHash(contentHash) { return (await this._bee.get(mapKey(contentHash))) !== null }

  delChunkMapByHash(contentHash) { return this._maps.del(mapKey(contentHash)) }

  // Drop the served hash's chunk map.
  evictContent(contentHash) { return this.delChunkMapByHash(contentHash) }
}
