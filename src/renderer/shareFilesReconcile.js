// Pure reconciliation for the foreign-folder listing, extracted from useShareFiles so it
// is unit-testable. The peer catalog read can transiently return an empty or partial snapshot
// while the owner is still indexing; the worker tags each read complete:true|false and this
// applies it without ever flashing the view empty:
//   - complete            → authoritative; adopt wholesale (adds, updates AND removals).
//   - !complete & empty   → keep the current list (rows are un-replicated, not deleted).
//   - !complete & partial → union by relPath, preferring the fresh row.
// Both prev and next arrive sorted by relPath (the catalog read-stream is key-ordered), so the
// partial-path merge is one O(n) two-pointer pass that returns the prev reference unchanged when
// nothing moved — letting React skip the re-render.
function sameRow(a, b) {
  return a.size === b.size && a.hash === b.hash && a.mtime === b.mtime &&
    a.status === b.status && a.localPath === b.localPath
}

export function reconcileFiles(prev, next, { complete }) {
  if (complete) return next
  if (next.length === 0) return prev
  const out = []
  let i = 0
  let j = 0
  let changed = false
  while (i < prev.length && j < next.length) {
    const a = prev[i]
    const b = next[j]
    if (a.relPath === b.relPath) {
      out.push(b)
      if (!sameRow(a, b)) changed = true
      i++
      j++
    } else if (a.relPath < b.relPath) {
      out.push(a)
      i++
    } else {
      out.push(b)
      changed = true
      j++
    }
  }
  while (i < prev.length) out.push(prev[i++])
  while (j < next.length) { out.push(next[j++]); changed = true }
  return changed ? out : prev
}
