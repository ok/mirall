// One view-model for both file-row kinds: the loose space-root row and the folder-share row. Given
// the row, its phase-tagged decoration and the sender-side download summary, decide which right-hand
// lane the row shows, which badge it wears, and the derived progress arithmetic. i18n and ETA
// formatting stay in the component; this is branching + arithmetic only, so it is unit-tested in
// plain Node.
//
// `kind` selects the badge table and nothing else: every branch below is shared, so a rule that
// holds for one row holds for both by construction. That is the point of the module, not the line
// count.
//
// Status is worker-derived; this only decorates. It never reads or writes IPC.
import { badgeStyle, fileStatusToBadge, shareFileStatusToBadge } from './statusBadge.js'

const pct = (bytes, total) => (total > 0 ? Math.min(100, Math.round((bytes / total) * 100)) : 0)

// "The bytes are on this device." 'downloaded' is on both vocabularies; 'synced' is share-only and
// is a mirror's terminal state. Naming both here is what lets ONE showVerified rule serve both
// kinds — gating on 'downloaded' alone would hide the check on every mirrored row.
const ON_DEVICE = new Set(['downloaded', 'synced'])

// The stand-in frame for a row whose download was just requested and whose first real frame has not
// arrived. Shaped exactly like a decoration — `eta: null` above all, which is what makes the bar
// read "Estimating…" (resolveEta) instead of freezing at a static 0%. It can only ever be built
// when `decoration` is null, so a real frame outranks it by construction rather than by a rule.
function seedFrame(row, seeded) {
  if (!seeded) return null
  if (row.status !== 'downloading' && row.status !== 'preparing') return null
  if (!(row.size > 0)) return null
  return {
    bytes: row.pendingBytes ?? 0,
    total: row.size,
    speed: 0,
    avgSpeed: 0,
    eta: null,
    // A preparing row is waiting on the OWNER's hash, so its stand-in must carry that phase or
    // pickDecorations files it as a download frame and paints the wrong lane.
    phase: row.status === 'preparing' ? 'preparing' : undefined,
  }
}

function pickDecorations(decoration) {
  // The decoration channel is shared by key across phases; a lingering cross-phase frame paints
  // the CURRENT phase only. Downloads read only download/verify frames, never a stale publish/prepare one.
  const downloadDecor =
    decoration && decoration.phase !== 'publishing' && decoration.phase !== 'preparing' ? decoration : null
  const publishDecor = decoration?.phase === 'publishing' ? decoration : null
  const preparingDecor = decoration?.phase === 'preparing' ? decoration : null
  return { downloadDecor, publishDecor, preparingDecor }
}

function deriveProgress(row, downloadDecor) {
  const isDownloading = row.status === 'downloading'
  const isVerifying = isDownloading && downloadDecor?.phase === 'verifying'
  const waiting = isDownloading && (downloadDecor?.bytes ?? 0) === 0
  const displayStatus = isVerifying ? 'verifying' : waiting ? 'preparing' : row.status

  const isPaused = row.status === 'paused-offline' || row.status === 'paused-interrupted'
  const pausedBytes = isPaused ? row.pendingBytes : undefined
  const pausedTotal = isPaused ? row.size : undefined
  const progressBytes = downloadDecor?.bytes ?? pausedBytes
  const progressTotal = downloadDecor?.total ?? pausedTotal
  const showDownloadProgress =
    (isDownloading && !waiting) ||
    (isPaused && progressBytes != null && progressTotal != null && progressTotal > 0)

  return { isDownloading, isVerifying, waiting, displayStatus, progressBytes, progressTotal, showDownloadProgress }
}

function deriveLane(row, progress, preparingDecor, downloadSummary) {
  const hasDownloaders = (downloadSummary?.peerKeys.length ?? 0) > 0
  const peerPreparingActive = row.status === 'preparing' && preparingDecor != null && preparingDecor.total > 0
  const downloadProgressActive =
    progress.showDownloadProgress && progress.progressBytes != null && progress.progressTotal != null

  // ONE precedence order, and this is it. Publishing outranks everything because it is OUR OWN
  // hash of OUR OWN file and cannot coexist with a transfer of it; verify outranks download because
  // it is a sub-phase of one; a paused partial reaches the download lane through
  // showDownloadProgress rather than a lane of its own; the sender-side indicator is what a row
  // shows when it has no work of its own to report.
  const lane =
    row.status === 'publishing' ? 'publish'
      : progress.isVerifying ? 'verify'
        : downloadProgressActive ? 'download'
          : peerPreparingActive ? 'preparing'
            : hasDownloaders ? 'indicator'
              : 'rest'
  return { lane, indicatorActive: lane === 'indicator', peerPreparingActive }
}

// Bytes of a not-yet-complete file that are already on this device. The live transfer frame while
// the row is actually transferring, the durable partial otherwise — and NOT the frame on any other
// row: the decoration key is shared across phases, so a publishing/preparing frame is the hash
// walking the file (no bytes arrived here), and a frame left on a row that has moved on is stale.
// Counting either would make a mirror's "still to fetch" read a whole un-fetched file as done.
export function rowBytesOnDevice(row, decoration) {
  const { downloadDecor } = pickDecorations(decoration)
  if (row.status === 'downloading' && downloadDecor) return downloadDecor.bytes
  return row.pendingBytes ?? 0
}

export function deriveRowView(row, decoration, downloadSummary, opts = {}) {
  const { kind = 'loose', isOwn = false, seeded = false } = opts
  const frame = decoration ?? seedFrame(row, seeded)
  const { downloadDecor, publishDecor, preparingDecor } = pickDecorations(frame)
  const progress = deriveProgress(row, downloadDecor)
  const { lane, indicatorActive, peerPreparingActive } = deriveLane(row, progress, preparingDecor, downloadSummary)

  // The two vocabularies are not interchangeable: FILE_STATUS has 'mine' and no 'synced';
  // SHARE_FILE_STATUS has 'synced', which collapses to the 'mine' pill only for our own share.
  // Resolving the descriptor here — rather than passing a status to a badge component — is what
  // lets one lane component render both kinds.
  const badge = badgeStyle(
    kind === 'share'
      ? shareFileStatusToBadge(progress.displayStatus, isOwn)
      : fileStatusToBadge(progress.displayStatus),
  )

  return {
    lane,
    indicatorActive,
    badge,
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
    showVerified: row.verified === true && ON_DEVICE.has(row.status),
  }
}
