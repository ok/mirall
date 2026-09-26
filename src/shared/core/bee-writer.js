// Serialized read-modify-write per key. The lock orders the writes; `cas` asserts nothing bypassed
// it and turns a silent lost update into a retry. A fresh read only narrows the lost-update
// window — ordering is what closes it.
//
// Two hyperbee facts this depends on (2.27.3): cas(prev, next) runs ONLY when the key exists, so
// mutate() refuses a missing record and creation goes through put() — and deletes take the lock,
// or an unmount landing between a mutate's read and its write is undone with no cas to notice;
// and a falsy cas return makes put() a SILENT no-op, so the retry is driven by a flag set inside
// the callback, not by put()'s return value.
//
// No domain knowledge and no bare-* imports: the bee arrives as a dependency, so this loads under
// Node and unit-tests without a store.
import { createKeyedLock } from './concurrency.js'

const MAX_ATTEMPTS = 3

// True when `next` would be stored as the value already held. JSON semantics: an undefined property
// is not stored, so it equals an absent one; object key order is not significant; array order is.
export function sameStoredValue(a, b) {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameStoredValue(v, b[i]))
  }
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  const keys = storedKeys(a)
  return keys.length === storedKeys(b).length && keys.every((k) => Object.hasOwn(b, k) && sameStoredValue(a[k], b[k]))
}

const storedKeys = (o) => Object.keys(o).filter((k) => o[k] !== undefined)

export function createRecordWriter({ bee, log, attempts = MAX_ATTEMPTS } = {}) {
  // Per KEY, not global: two different records have no reason to serialize against each other, and
  // a minutes-long scan settle must not block an unrelated probe.
  const exclusive = createKeyedLock()

  return {
    put: (key, value) => exclusive(key, () => bee().put(key, value)),

    del: (key) => exclusive(key, () => bee().del(key)),

    // A create that never replaces: resolves the value already stored (and writes nothing), or null
    // once it has written `value`.
    insert: (key, value) => exclusive(key, async () => {
      const entry = await bee().get(key)
      if (entry?.value) return entry.value
      await bee().put(key, value)
      return null
    }),

    // Resolves to the value the record now holds — written, or already stored when `apply` returned
    // an equal value — or null when the record is gone (the documented no-op every caller relies on)
    // or `apply` declined. `apply` receives a deep copy of the stored value and returns the next value,
    // or a falsy value to decline the write; an equal value costs no block either.
    mutate: (key, apply) => exclusive(key, async () => (await commit(key, apply))?.value ?? null),

    // mutate, answering { value, previous, written } so a caller can tell a write from an equal value.
    mutateWithOutcome: (key, apply) => exclusive(key, () => commit(key, apply)),
  }

  async function commit(key, apply) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const entry = await bee().get(key)
      if (!entry?.value) return null
      const next = apply(JSON.parse(JSON.stringify(entry.value)))
      if (!next) return null
      if (sameStoredValue(next, entry.value)) return { value: entry.value, previous: entry.value, written: false }
      let superseded = false
      await bee().put(key, next, {
        cas: (prev) => {
          if (prev.seq === entry.seq) return true
          superseded = true
          return false
        },
      })
      if (!superseded) return { value: next, previous: entry.value, written: true }
      log?.warn('record changed under a serialized write — retrying:', key)
    }
    // Losing the race `attempts` times in a row means a writer outside the lock, not
    // contention. Loud, because a silent give-up here is the lost update this exists to prevent.
    throw new Error(`could not commit ${key} after ${attempts} attempts`)
  }
}
