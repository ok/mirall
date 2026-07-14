// Derive the folder header totals (count + size) from a share:list-files result.
//
// share:list-files caps its rows at listFilesCap but streams the TRUE {total, totalBytes} for the
// whole share in the same pass, plus an explicit `truncated` flag. So:
//  - on a COMPLETE read, trust res.total/res.totalBytes — the displayed rows may be capped below
//    them, which is what the over-the-limit banner reports;
//  - on an INCOMPLETE read (a transient/offline peer read), res.total reflects only the partial
//    read while `rows` is the reconciled last-good list actually on screen, so it may only ever
//    RAISE the count, never lower it below those rows. A header reading lower than the visible list
//    is always wrong — and deriving truncation from it used to make a capped listing look complete.
export function deriveFolderInfo(res, rows) {
  const rowBytes = rows.reduce((sum, f) => sum + (Number.isFinite(f.size) ? f.size : 0), 0)
  const reportedCount = typeof res?.total === 'number' ? res.total : 0
  const reportedBytes = typeof res?.totalBytes === 'number' ? res.totalBytes : rowBytes
  const complete = !!res?.complete
  return {
    fileCount: complete ? reportedCount : Math.max(reportedCount, rows.length),
    totalBytes: complete ? reportedBytes : Math.max(reportedBytes, rowBytes),
    blobsLength: null,
    truncated: !!res?.truncated,
    fileLimit: typeof res?.fileLimit === 'number' ? res.fileLimit : null,
  }
}
