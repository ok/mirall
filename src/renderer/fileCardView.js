// Pure view-model for a file row: given the file, its phase-tagged decoration, and the
// sender-side download summary, decide which right-hand "lane" the row shows plus the derived
// progress numbers. i18n/ETA formatting stays in the component; this is only branching +
// arithmetic, so it's unit-tested in plain Node. Status is worker-derived; this only decorates.

const pct = (bytes, total) => (total > 0 ? Math.min(100, Math.round((bytes / total) * 100)) : 0)

function pickDecorations(decoration) {
  // The decoration channel is shared by key across phases; a lingering cross-phase frame paints
  // the CURRENT phase only. Downloads read only download/verify frames, never a stale publish/prepare one.
  const downloadDecor =
    decoration && decoration.phase !== 'publishing' && decoration.phase !== 'preparing' ? decoration : null
  const publishDecor = decoration?.phase === 'publishing' ? decoration : null
  const preparingDecor = decoration?.phase === 'preparing' ? decoration : null
  return { downloadDecor, publishDecor, preparingDecor }
}

function deriveProgress(file, downloadDecor) {
  const isDownloading = file.status === 'downloading'
  const isVerifying = isDownloading && downloadDecor?.phase === 'verifying'
  const waiting = isDownloading && (downloadDecor?.bytes ?? 0) === 0
  const displayStatus = isVerifying ? 'verifying' : waiting ? 'preparing' : file.status

  const isPaused = file.status === 'paused-offline' || file.status === 'paused-interrupted'
  const pausedBytes = isPaused ? file.pendingBytes : undefined
  const pausedTotal = isPaused ? file.size : undefined
  const progressBytes = downloadDecor?.bytes ?? pausedBytes
  const progressTotal = downloadDecor?.total ?? pausedTotal
  const showDownloadProgress =
    (isDownloading && !waiting) ||
    (isPaused && progressBytes != null && progressTotal != null && progressTotal > 0)

  return { isDownloading, isVerifying, waiting, displayStatus, progressBytes, progressTotal, showDownloadProgress }
}

function deriveLane(file, progress, preparingDecor, downloadSummary) {
  const hasDownloaders = (downloadSummary?.peerKeys.length ?? 0) > 0
  const peerPreparingActive = file.status === 'preparing' && preparingDecor != null && preparingDecor.total > 0
  const downloadProgressActive =
    progress.showDownloadProgress && progress.progressBytes != null && progress.progressTotal != null

  const lane =
    file.status === 'publishing' ? 'publish'
      : progress.isVerifying ? 'verify'
        : downloadProgressActive ? 'download'
          : peerPreparingActive ? 'preparing'
            : hasDownloaders ? 'indicator'
              : 'rest'
  return { lane, indicatorActive: lane === 'indicator', peerPreparingActive }
}

export function deriveFileCardView(file, decoration, downloadSummary) {
  const { downloadDecor, publishDecor, preparingDecor } = pickDecorations(decoration)
  const progress = deriveProgress(file, downloadDecor)
  const { lane, indicatorActive, peerPreparingActive } = deriveLane(file, progress, preparingDecor, downloadSummary)

  return {
    lane,
    indicatorActive,
    displayStatus: progress.displayStatus,
    isDownloading: progress.isDownloading,
    downloadDecor,
    publishDecor,
    preparingDecor,
    progressBytes: progress.progressBytes,
    progressTotal: progress.progressTotal,
    verifyPct: downloadDecor?.verifyFraction != null ? Math.round(downloadDecor.verifyFraction * 100) : 0,
    publishPct: publishDecor ? pct(publishDecor.bytes, publishDecor.total) : 0,
    downloadPct: progress.progressBytes != null && progress.progressTotal ? pct(progress.progressBytes, progress.progressTotal) : 0,
    preparingPct: peerPreparingActive ? pct(preparingDecor.bytes, preparingDecor.total) : 0,
    showVerified: file.verified === true && file.status === 'downloaded',
  }
}
