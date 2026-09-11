// Consecutive failed attempts per (file, advertised hash), and the point at which a producer should
// stop asking.
//
// A PERMANENT block is wrong for a multi-source overlay: the first holder to serve corrupt bytes
// would poison content a second, healthy holder could serve correctly, with no way back short of a
// remount. A budget gives the other holders their turn and still ends the unbounded retry.
//
// Bounded by EVICTION, not by refusing to record. A memo that stops recording at its cap silently
// stops blocking, which is exactly how the loop this exists to end would come back on a mount with
// more corrupt files than the cap.
// test seam
export const DEFAULT_ATTEMPT_LIMIT = 3
// test seam
export const DEFAULT_MAX_KEYS = 512

export function createAttemptBudget({ limit = DEFAULT_ATTEMPT_LIMIT, maxKeys = DEFAULT_MAX_KEYS } = {}) {
  const byMount = new Map()
  const keyOf = (relPath, contentHash) => relPath + '\0' + (contentHash || '')

  function entriesFor(mountKey) {
    let m = byMount.get(mountKey)
    if (!m) {
      m = new Map()
      byMount.set(mountKey, m)
    }
    return m
  }

  return {
    // Record one failure and return the new count. Re-inserting moves the key to the end, so the
    // eviction below drops the least recently failed rather than the first ever seen.
    fail(mountKey, relPath, contentHash) {
      const m = entriesFor(mountKey)
      const k = keyOf(relPath, contentHash)
      const next = (m.get(k) ?? 0) + 1
      m.delete(k)
      m.set(k, next)
      if (m.size > maxKeys) m.delete(m.keys().next().value)
      return next
    },
    // Has this claim spent its budget? A claim evicted under pressure answers false and is tried
    // again — bounded churn, which is the honest trade for a bounded map.
    exhausted(mountKey, relPath, contentHash) {
      return (byMount.get(mountKey)?.get(keyOf(relPath, contentHash)) ?? 0) >= limit
    },
    // A landed file, or an owner re-publishing under a new hash, clears the record: the next
    // failure starts a fresh budget rather than inheriting one it never spent.
    succeed(mountKey, relPath, contentHash) {
      byMount.get(mountKey)?.delete(keyOf(relPath, contentHash))
    },
    forget(mountKey) { byMount.delete(mountKey) },
    clear() { byMount.clear() },
    size(mountKey) { return byMount.get(mountKey)?.size ?? 0 },
  }
}
