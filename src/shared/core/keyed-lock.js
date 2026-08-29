// Per-key serialization: chains async functions on a per-key promise so each runs
// after the previous settles. The stored tail swallows rejections so one failure
// can't poison the chain; the returned promise still rejects so the caller sees errors.
// A key's entry is dropped once its chain drains, so the map stays bounded by the keys
// actually in flight rather than by every key the process has ever touched.
export function createKeyedLock () {
  const chains = new Map()
  function runExclusive (key, fn) {
    const prev = chains.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.then(() => {}, () => {})
    chains.set(key, tail)
    tail.then(() => { if (chains.get(key) === tail) chains.delete(key) })
    return next
  }
  runExclusive.pending = () => chains.size
  return runExclusive
}
