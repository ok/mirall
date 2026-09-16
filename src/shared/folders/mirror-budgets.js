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
/** @internal */
export const DEFAULT_ATTEMPT_LIMIT = 3
/** @internal */
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

// One integrity row per (mount, file, advertised hash) — not one per retry tick. A mirror
// re-materializes on a 30 s poll AND on every owner catalog append, so a holder that keeps serving
// bytes failing their hash would otherwise write the same fact thousands of times a day and burn
// the audit log's per-kind rate budget, collapsing real rows into audit.suppressed.
//
// Keyed on the hash as well as the path, because a re-publish is a NEW claim: the owner
// advertising different bytes under a new hash and failing again is a second fact, not a repeat.
//
// Bounded per mount. At the cap the mount stops recording and announces it once — 512 rows already
// say "this holder is serving corrupt content", and an unbounded Set on a 150k-file mirror is a
// leak. This is a bounded gap, not a silent one: every suppressed case still produced its console
// warning, and the cap itself is logged.
/** @internal */
export const DEFAULT_INTEGRITY_ROW_CAP = 512

export function createIntegritySeen({ limit = DEFAULT_INTEGRITY_ROW_CAP, onCap = () => {} } = {}) {
  const byMount = new Map()

  return {
    admit(mountKey, relPath, contentHash) {
      let seen = byMount.get(mountKey)
      if (!seen) {
        seen = new Set()
        byMount.set(mountKey, seen)
      }
      const claim = relPath + '\0' + (contentHash || '')
      if (seen.has(claim)) return false
      if (seen.size >= limit) return false
      seen.add(claim)
      if (seen.size === limit) onCap(mountKey, limit)
      return true
    },
    // An unmount/remount is a fresh session: the user re-pointing the mount is a new decision and
    // deserves to be told the folder is still corrupt.
    forget(mountKey) { byMount.delete(mountKey) },
    clear() { byMount.clear() },
    size(mountKey) { return byMount.get(mountKey)?.size ?? 0 },
  }
}
