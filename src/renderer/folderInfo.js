// Derive the folder header totals (count + size) from a share:list-files result.
//
// share:list-files caps its rows at listFilesCap but streams the TRUE {total, totalBytes}
// for the whole share in the same pass. So:
//  - on a COMPLETE read, trust res.total/res.totalBytes — the displayed rows may be capped
//    below them, which is exactly what drives the "first N of M" banner;
//  - on an INCOMPLETE read (a transient/offline peer read), res.total reflects only the
//    partial read while `rows` is the reconciled last-good list that's actually on screen,
//    so derive from `rows`. This avoids a "0 files / 0 B" header flashing over a populated
//    list (a plain `res.total ?? rows.length` would NOT catch a valid 0).
export function deriveFolderInfo(res, rows) {
  const sumRows = () => rows.reduce((sum, f) => sum + (Number.isFinite(f.size) ? f.size : 0), 0)
  if (res && res.complete && typeof res.total === 'number') {
    return {
      fileCount: res.total,
      totalBytes: typeof res.totalBytes === 'number' ? res.totalBytes : sumRows(),
      blobsLength: null,
    }
  }
  return { fileCount: rows.length, totalBytes: sumRows(), blobsLength: null }
}
