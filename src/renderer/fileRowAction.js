// Which action affordance a folder-view file row offers for a transfer status.
// manualControls is true when the member browses a share without mirroring it —
// each file is downloaded/paused/resumed/discarded by hand. A mirrored share
// syncs automatically, so its rows only ever show reveal or a busy spinner.
export function fileRowAction ({ status, manualControls, hasTransferId }) {
  if (status === 'downloaded' || status === 'synced') return 'reveal'

  if (manualControls) {
    if (status === 'downloading' || status === 'verifying') return hasTransferId ? 'pause-cancel' : 'busy'
    if (status === 'paused-interrupted') return 'resume-discard'
    if (status === 'paused-offline') return 'discard'
    if (status === 'error') return 'retry-discard'
    if (status === 'remote') return 'download'
    if (status === 'unavailable') return 'download-disabled'
    if (status === 'preparing') return 'busy'
    return 'none'
  }

  if (status === 'downloading' || status === 'verifying' || status === 'preparing') return 'busy'
  return 'none'
}
