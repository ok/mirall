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
//
// Identity matters as much as content: a row that did not change keeps its PREVIOUS object, so a
// memoized row component can skip it. Content is still always the fresh row's — see adoptIdentity.

// Every field toEntry (useShareFiles.ts) puts on a row EXCEPT relPath, which is the merge key and
// is compared by the callers below.
//
// This list is the contract: a row is "unchanged" only if it is unchanged in every field the view
// can render, because an unchanged row keeps its old object and its old values with it. Adding a
// field to toEntry without adding it here means that field's updates are silently dropped — the
// row keeps painting the stale value until one of the fields listed here happens to move.
//
// `progress` and `verifyFraction` are deliberately absent: they are NOT on toEntry. useShareFiles
// merges them over the reconciled row at render from the decoration channel, and `progress` is a
// fresh object on every decoration frame — comparing them here would make every active row unequal
// and defeat the identity adoption this function exists for.
function sameRow(a, b) {
  return a.size === b.size && a.hash === b.hash && a.mtime === b.mtime &&
    a.status === b.status && a.localPath === b.localPath &&
    a.verified === b.verified && a.pendingBytes === b.pendingBytes &&
    a.errorCode === b.errorCode && a.transferId === b.transferId
}

export function reconcileFiles(prev, next, { complete }) {
  // A complete read is authoritative for CONTENT — adds, updates and removals all apply. It is not
  // a reason to hand every unchanged row a new object identity: doing so defeats React.memo on the
  // row, which is the whole point of reconciling rather than replacing.
  if (complete) return adoptIdentity(prev, next)
  if (next.length === 0) return prev
  const out = []
  let i = 0
  let j = 0
  let changed = false
  while (i < prev.length && j < next.length) {
    const a = prev[i]
    const b = next[j]
    if (a.relPath === b.relPath) {
      const same = sameRow(a, b)
      // Keep the PREVIOUS object when the row is unchanged. Pushing `b` unconditionally gave every
      // row a new identity whenever any one row changed.
      out.push(same ? a : b)
      if (!same) changed = true
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

// Both lists are sorted by relPath, so this is the same O(n) walk: adopt the fresh row's content
// but keep the previous OBJECT wherever the two agree.
//
// Safe under a violated sort order: `out` is built entirely from `next`, one slot per entry, so
// the RESULT ALWAYS HAS EXACTLY next's CONTENT. An unsorted input only costs identity adoption
// (rows fall through to the fresh object), never correctness.
function adoptIdentity(prev, next) {
  if (prev.length === 0) return next
  const out = new Array(next.length)
  let i = 0
  let changed = false
  for (let j = 0; j < next.length; j++) {
    const b = next[j]
    // Rows in prev that next skipped past are removals — the authoritative read dropped them.
    while (i < prev.length && prev[i].relPath < b.relPath) { i++; changed = true }
    const a = i < prev.length && prev[i].relPath === b.relPath ? prev[i] : null
    if (a && sameRow(a, b)) out[j] = a
    else { out[j] = b; changed = true }
    if (a) i++
  }
  // Anything left in prev is a removal too (next ended first).
  if (i < prev.length) changed = true
  // Returning `prev` when the lists are genuinely identical keeps the ARRAY reference stable as
  // well — the property the header comment claims and the partial branch already delivers.
  return changed ? out : prev
}
