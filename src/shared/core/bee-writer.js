// One serialized write path for a hyperbee whose records are read-modified-written. The pattern it
// replaces — `get` → spread → `put` — loses a field whenever two continuations interleave, and the
// lost field is always a status latch (paused, enabled, an error, a path), which is why the same
// bug kept coming back in a different helper each time. A fresh read narrows that window; only
// ordering closes it.
//
// The lock is the mechanism and `cas` is an assertion on top, not the other way round: within one
// process the lock is what orders the writes, and one worker owns each local bee. `cas` catches the
// case the lock cannot — a writer that bypassed it — and turns a silent lost update into a retry.
//
// Two hyperbee facts this depends on (2.27.3):
//   - cas(prev, next) is invoked ONLY when the key already exists, so it cannot express "create if
//     absent"; that is why mutate() refuses a missing record up front and creation goes through
//     put(). It is also why deletes take the lock: an unmount landing between a mutate's read and
//     its write would otherwise be undone by that write, with no cas call to notice.
//   - a falsy cas return makes put() a SILENT no-op, so the retry has to be driven by a flag set
//     inside the callback, not by put()'s return value.
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
