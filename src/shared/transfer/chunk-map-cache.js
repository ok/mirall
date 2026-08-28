// Bounded LRU of DECODED chunk maps, keyed by the FileIndex bee key the map is stored under
// ('chunkmap-oid:<hash>' / 'chunkmap:<path>'). Injected into the vendored FileIndex from
// overlay-instance.js the way the bandwidth limiters are injected into the protocol, so
// vendor/ keeps no app imports and an embedder that injects nothing decodes from the bee on
// every read, as upstream does.
//
// Sized by an estimated resident byte cost the caller supplies. Eviction is least-recently-
// used with one deliberate exception: the entry just inserted is ALWAYS kept, even when it
// alone exceeds maxBytes. A map that does not fit is exactly the map whose re-decode is most
// expensive (a 1 TiB tier-3 file is ~1M entries), and the process already held it whole to
// serve it; refusing it would leave the largest transfers on the per-chunk-decode path this
// cache exists to remove. The budget bounds the steady state; the overflow is one map.
//
// Values are shared by reference between every consumer and must be treated as frozen.
// maxBytes 0 disables the cache (get always misses, set is a no-op) — the runtime-config
// rollback gate. Pure: no imports, so it runs under brittle-node.
export function createChunkMapCache({ maxBytes } = {}) {
  const max = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : 0
  const entries = new Map() // insertion order is recency order; a touch is delete + set
  let bytes = 0

  function evict() {
    for (const [key, entry] of entries) {
      if (bytes <= max || entries.size <= 1) return
      entries.delete(key)
      bytes -= entry.bytes
    }
  }

  return {
    get maxBytes() { return max },
    get bytes() { return bytes },
    get size() { return entries.size },
    get(key) {
      const entry = entries.get(key)
      if (!entry) return undefined
      entries.delete(key)
      entries.set(key, entry)
      return entry.value
    },
    set(key, value, cost) {
      if (max === 0 || !value) return
      const size = typeof cost === 'number' && cost > 0 ? cost : 0
      const prev = entries.get(key)
      if (prev) { entries.delete(key); bytes -= prev.bytes }
      entries.set(key, { value, bytes: size })
      bytes += size
      evict()
    },
    delete(key) {
      const entry = entries.get(key)
      if (!entry) return false
      entries.delete(key)
      bytes -= entry.bytes
      return true
    },
    clear() { entries.clear(); bytes = 0 },
  }
}
