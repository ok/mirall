// An optimistic row is dropped once the server listing surfaces the same path: the worker
// advertises a file while it is still hashing, so files:list carries it before the publish
// finishes. Keeping both would show the file twice, and the server row is the one that survives a
// remount.
//
// Until then a pending row sits where the server will list it, so it does not move when its server
// row replaces it. The listing leads with our own files in catalog key order (UTF-8 bytes, which is
// code-point order) and follows with peer-only files; only our own rows carry these statuses in a
// loose listing.
/** @import { FileEntry } from '../types/types.js' */

const OWN_STATUSES = new Set(['synced', 'publishing', 'queued'])

/** @param {string} a @param {string} b */
function codePointBefore(a, b) {
  const x = [...a]
  const y = [...b]
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = /** @type {number} */ (x[i].codePointAt(0)) - /** @type {number} */ (y[i].codePointAt(0))
    if (d !== 0) return d < 0
  }
  return x.length < y.length
}

/** @param {FileEntry[]} serverRows @param {FileEntry[]} optimisticRows */
export function mergeOptimistic(serverRows, optimisticRows) {
  if (optimisticRows.length === 0) return serverRows
  const known = new Set(serverRows.map((row) => row.path))
  const pending = optimisticRows.filter((row) => !known.has(row.path))
  if (pending.length === 0) return serverRows
  const ownEnd = serverRows.findIndex((row) => !OWN_STATUSES.has(row.status))
  const own = ownEnd === -1 ? serverRows : serverRows.slice(0, ownEnd)
  const merged = [...own]
  for (const row of pending) {
    const at = merged.findIndex((other) => codePointBefore(row.path, other.path))
    merged.splice(at === -1 ? merged.length : at, 0, row)
  }
  return ownEnd === -1 ? merged : [...merged, ...serverRows.slice(ownEnd)]
}
