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
