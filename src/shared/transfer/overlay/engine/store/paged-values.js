// Large JSON arrays stored under one Hyperbee key. Hypercore caps a block at 15 MiB and a chunk map
// for a 1.1 TB file is ~120 MB of JSON, so an array over PAGE_ENTRIES is stored as a
// { __paged: N } header plus N `<key>\x00<i>` pages, committed in one batch; smaller ones stay inline
// as a plain array. The NUL never occurs in a path or hex hash, so a page key cannot collide.
//
// Owns the host-injected cache of DECODED values and the mutation fence that keeps a decode racing
// a write of the same key from caching the old value.

// ~116 B per entry worst-case JSON, so a page stays ≤ ~3.8 MB, well under the block limit.
const PAGE_ENTRIES = 32768
// The resident cost charged to the cache per decoded map: a 64-char hash string, a three-field
// object, an array slot, and headroom for heap numbers past 2 GiB offsets. Deliberately generous so
// the byte budget stays a bound.
const ENTRY_BYTES = 160
const BASE_BYTES = 64

export class PagedValues {
  // `bee()` returns the current bee (compaction swaps it); `cache` may be null.
  constructor({ bee, cache = null }) {
    this._bee = bee
    this._cache = cache
    this._mutations = 0
  }

  async put(key, values) {
    try { await this._write(key, values) } finally { this._invalidate(key) }
  }

  // The cache first; on a miss, decode from the bee and cache the result unless a write to this key
  // landed while the decode was in flight.
  async get(key) {
    const hit = this._cache ? this._cache.get(key) : undefined
    if (hit) return hit
    const fence = this._mutations
    const values = await this._decode(key)
    if (values && this._cache && fence === this._mutations) {
      this._cache.set(key, values, BASE_BYTES + values.length * ENTRY_BYTES)
    }
    return values
  }

  async del(key) {
    try { await this._erase(key) } finally { this._invalidate(key) }
  }

  // Every value may have changed (compaction): nothing cached survives.
  invalidateAll() {
    this._mutations++
    if (this._cache) this._cache.clear()
  }

  clear() {
    if (this._cache) this._cache.clear()
  }

  // AFTER a write: the fence moves so an in-flight decode does not cache what it read, then the
  // cached value goes. Before would let a decode that starts in between cache the pre-write value.
  _invalidate(key) {
    this._mutations++
    if (this._cache) this._cache.delete(key)
  }

  // Stale pages of a previously larger value at the same key go in the same batch.
  async _write(key, values) {
    const prevPages = await this._pageCount(key)
    if (values.length <= PAGE_ENTRIES) {
      if (prevPages === 0) return this._bee().put(key, values)
      return this._batched(async (b) => {
        await b.put(key, values)
        for (let i = 0; i < prevPages; i++) await b.del(`${key}\x00${i}`)
      })
    }
    const pageCount = Math.ceil(values.length / PAGE_ENTRIES)
    return this._batched(async (b) => {
      await b.put(key, { __paged: pageCount })
      for (let i = 0; i < pageCount; i++) await b.put(`${key}\x00${i}`, values.slice(i * PAGE_ENTRIES, (i + 1) * PAGE_ENTRIES))
      for (let i = pageCount; i < prevPages; i++) await b.del(`${key}\x00${i}`)
    })
  }

  // The header and all pages commit in one batch, so a missing or non-array page means the value is
  // corrupt or incomplete: null, a clean miss the caller rebuilds from, never a truncated array.
  async _decode(key) {
    const entry = await this._bee().get(key)
    if (!entry) return null
    if (Array.isArray(entry.value)) return entry.value
    const pageCount = entry.value.__paged
    if (!pageCount) return null
    const values = []
    for (let i = 0; i < pageCount; i++) {
      const page = await this._bee().get(`${key}\x00${i}`)
      if (!page || !Array.isArray(page.value)) return null
      for (const v of page.value) values.push(v)
    }
    return values
  }

  async _erase(key) {
    const prevPages = await this._pageCount(key)
    if (prevPages === 0) return this._bee().del(key)
    return this._batched(async (b) => {
      await b.del(key)
      for (let i = 0; i < prevPages; i++) await b.del(`${key}\x00${i}`)
    })
  }

  // The page count of an existing paged value, or 0 when the key is absent or inline.
  async _pageCount(key) {
    const entry = await this._bee().get(key)
    if (!entry || Array.isArray(entry.value)) return 0
    return entry.value.__paged || 0
  }

  // flush releases the batch's lock itself, even on an append failure; an error before it closes
  // the batch.
  async _batched(fn) {
    const b = this._bee().batch()
    try {
      await fn(b)
      await b.flush()
    } catch (err) {
      try { await b.close() } catch {}
      throw err
    }
  }
}
