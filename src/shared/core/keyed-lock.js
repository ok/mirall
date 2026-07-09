// Per-key serialization: chains async functions on a per-key promise so each runs
// after the previous settles. The stored tail swallows rejections so one failure
// can't poison the chain; the returned promise still rejects so the caller sees errors.
export function createKeyedLock () {
  const chains = new Map()
  return function runExclusive (key, fn) {
    const prev = chains.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    chains.set(key, next.then(() => {}, () => {}))
    return next
  }
}
