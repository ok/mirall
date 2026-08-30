// Insertion-ordered Map as an LRU: delete+set moves a key to the end, so the first key is the
// oldest. Refcounted because the values here are live handles — an entry a caller is currently
// reading must never be closed underneath it, so eviction only ever considers refs === 0.
// A limit of 0 (or less) never evicts, which is the unbounded behaviour this replaces.
export function createRefCountedLru({ limit, onEvict = () => {} } = {}) {
  const capOf = typeof limit === 'function' ? limit : () => limit
  const entries = new Map()

  function evictIfNeeded() {
    const cap = capOf()
    if (!(cap > 0)) return
    for (const [key, entry] of [...entries]) {
      if (entries.size <= cap) return
      if (entry.refs > 0) continue
      entries.delete(key)
      onEvict(key, entry.value)
    }
  }

  return {
    get(key) {
      const entry = entries.get(key)
      if (!entry) return null
      entries.delete(key)
      entries.set(key, entry)
      return entry.value
    },
    set(key, value) {
      const existing = entries.get(key)
      entries.delete(key)
      entries.set(key, { value, refs: existing ? existing.refs : 0 })
      evictIfNeeded()
    },
    // Pins an entry for as long as something holds it. Balanced by release(); an unbalanced
    // acquire pins the entry for the life of the process, which is a leak, not a crash.
    acquire(key) {
      const entry = entries.get(key)
      if (!entry) return null
      entry.refs += 1
      return entry.value
    },
    release(key) {
      const entry = entries.get(key)
      if (entry && entry.refs > 0) entry.refs -= 1
      evictIfNeeded()
    },
    delete(key) {
      const entry = entries.get(key)
      if (!entry) return null
      entries.delete(key)
      return entry.value
    },
    has: (key) => entries.has(key),
    size: () => entries.size,
    keys: () => [...entries.keys()],
    refsOf: (key) => entries.get(key)?.refs ?? 0,
    clear() { entries.clear() },
    values: () => [...entries.values()].map((e) => e.value),
  }
}
