// Pure reconciliation for the foreign-folder listing. A peer catalog read can transiently return an
// empty or partial snapshot while the owner is still indexing; the worker tags each read
// complete:true|false and this applies it without ever flashing the view empty:
//   - complete            → authoritative; adopt wholesale (adds, updates AND removals).
//   - !complete & empty   → keep the current list (rows are un-replicated, not deleted).
//   - !complete & partial → union by relPath, preferring the fresh row.
// Both sides arrive sorted by relPath, so the merge is one two-pointer pass that returns the prev
// reference when nothing moved. Identity matters as much as content: an unchanged row keeps its
// PREVIOUS object so a memoized row can skip it — see adoptIdentity.

/** @import { ShareFileRow } from '../types/types.js' */

// Every row field except the merge key. Typed total over `ShareFileRow`, so a new field fails `tsc`
// until it is compared here; an unchanged row keeps its old object AND values, so a field missing
// here would paint stale. Live transfer progress is not a row field — it reaches the row per path
// from the decoration channel, so a frame never touches the row object.
/** @type {Readonly<Record<Exclude<keyof ShareFileRow, 'relPath'>, true>>} */
const COMPARED = {
  size: true,
  hash: true,
  mtime: true,
  status: true,
  localPath: true,
  verified: true,
  mirrored: true,
  pendingBytes: true,
  errorCode: true,
  transferId: true,
}
const KEYS = /** @type {(keyof typeof COMPARED)[]} */ (Object.keys(COMPARED))

/** @param {ShareFileRow} a @param {ShareFileRow} b */
function sameRow(a, b) {
  return KEYS.every((k) => a[k] === b[k])
}

/** @param {ShareFileRow[]} prev @param {ShareFileRow[]} next @param {{ complete: boolean }} opts */
export function reconcileFiles(prev, next, { complete }) {
  // A complete read is authoritative for CONTENT — adds, updates and removals all apply. It is not
  // a reason to hand every unchanged row a new object identity: doing so defeats React.memo on the
  // row, which is the whole point of reconciling rather than replacing.
  if (complete) return adoptIdentity(prev, next)
  if (next.length === 0) return prev
  /** @type {ShareFileRow[]} */
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
/** @param {ShareFileRow[]} prev @param {ShareFileRow[]} next */
function adoptIdentity(prev, next) {
  if (prev.length === 0) return next
  /** @type {ShareFileRow[]} */
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
