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
import { createKeyedLock } from './keyed-lock.js'

const MAX_ATTEMPTS = 3

export function createRecordWriter({ bee, log, attempts = MAX_ATTEMPTS } = {}) {
  // Per KEY, not global: two different records have no reason to serialize against each other, and
  // a minutes-long scan settle must not block an unrelated probe.
  const exclusive = createKeyedLock()

  return {
    put: (key, value) => exclusive(key, () => bee().put(key, value)),

    del: (key) => exclusive(key, () => bee().del(key)),

    // Returns false when the record is gone — the documented no-op every caller relies on — and
    // true otherwise. `apply` receives a copy of the stored value and returns the next value, or a
    // falsy value to decline the write, which is what keeps an unchanged status from appending a
    // block per probe tick.
    mutate(key, apply) {
      return exclusive(key, async () => {
        for (let attempt = 0; attempt < attempts; attempt++) {
          const entry = await bee().get(key)
          if (!entry?.value) return false
          const next = apply({ ...entry.value })
          if (!next) return true
          let superseded = false
          await bee().put(key, next, {
            cas: (prev) => {
              if (prev.seq === entry.seq) return true
              superseded = true
              return false
            },
          })
          if (!superseded) return true
          log?.warn('record changed under a serialized write — retrying:', key)
        }
        // Losing the race `attempts` times in a row means a writer outside the lock, not
        // contention. Loud, because a silent give-up here is the lost update this exists to prevent.
        throw new Error(`could not commit ${key} after ${attempts} attempts`)
      })
    },
  }
}
