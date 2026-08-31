// One file row in a folder share: transfer status/progress, per-file actions, and the
// owner-side who-is-downloading indicator. Extracted from FolderView so the collapsible
// tree and the flat list can share it.
import { memo, useState, useId, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import Icon from '../primitives/Icon.js'
import IconButton from '../primitives/IconButton.js'
import VerifiedCheck from '../primitives/VerifiedCheck.js'
import Badge from '../primitives/Badge.js'
import DownloadProgressLane from '../widgets/DownloadProgressLane.js'
import PeerDownloadIndicator from './PeerDownloadIndicator.js'
import PeerDownloadDropdown from './PeerDownloadDropdown.js'
import FileName from '../widgets/FileName.js'
import { formatSize, formatSpeed, resolveEta, getFileIcon } from '../../utils.js'
import { errorCodeToI18nKey } from '../../errorMessages.js'
import { fileRowAction } from '../../fileRowAction.js'
import { badgeStyle, shareFileStatusToBadge } from '../../statusBadge.js'
import type { ShareFileEntry, SpaceMember, PeerDownloadSummary } from '../../types.js'

export interface ShareFileRowProps {
  file: ShareFileEntry
  isOwn: boolean
  manualControls: boolean
  spaceId: string
  members: SpaceMember[]
  downloadSummary: PeerDownloadSummary | null
  onDownload: (relPath: string) => void
  onReveal: (relPath: string) => void
  onPause: (transferId: string) => void
  onCancel: (transferId: string) => void
  onDiscardPartial: (relPath: string) => void
  displayName?: string
  leadingGutter?: boolean
}

interface FileRowActionsProps {
  action: string
  relPath: string
  transferId?: string
  busyLabel: string
  onDownload: (relPath: string) => void
  onReveal: (relPath: string) => void
  onPause: (transferId: string) => void
  onCancel: (transferId: string) => void
  onDiscardPartial: (relPath: string) => void
}

function FileRowActions({ action, relPath, transferId, busyLabel, onDownload, onReveal, onPause, onCancel, onDiscardPartial }: FileRowActionsProps) {
  const { t } = useTranslation()
  if (action === 'pause-cancel' && transferId) {
    return (
      <>
        <IconButton icon="pause" iconSize={22} iconClassName="text-secondary" onClick={() => onPause(transferId)} ariaLabel={t('file.pause')} title={t('file.pause')} />
        <IconButton icon="close" iconSize={22} iconClassName="text-error" onClick={() => onCancel(transferId)} ariaLabel={t('file.cancel')} title={t('file.cancel')} />
      </>
    )
  }
  if (action === 'resume-discard') {
    return (
      <>
        <IconButton icon="play_arrow" iconSize={22} iconClassName="text-secondary" onClick={() => onDownload(relPath)} ariaLabel={t('file.resume')} title={t('file.resume')} />
        <IconButton icon="close" iconSize={22} iconClassName="text-error" onClick={() => onDiscardPartial(relPath)} ariaLabel={t('file.discardPartial')} title={t('file.discardPartial')} />
      </>
    )
  }
  if (action === 'retry-discard') {
    return (
      <>
        <IconButton icon="refresh" iconSize={22} iconClassName="text-secondary" onClick={() => onDownload(relPath)} ariaLabel={t('file.retry')} title={t('file.retry')} />
        <IconButton icon="close" iconSize={22} iconClassName="text-error" onClick={() => onDiscardPartial(relPath)} ariaLabel={t('file.dismiss')} title={t('file.dismiss')} />
      </>
    )
  }
  if (action === 'discard') {
    return <IconButton icon="close" iconSize={22} iconClassName="text-error" onClick={() => onDiscardPartial(relPath)} ariaLabel={t('file.discardPartial')} title={t('file.discardPartial')} />
  }
  if (action === 'reveal') {
    return <IconButton icon="folder_open" iconSize={22} iconClassName="text-secondary" onClick={() => onReveal(relPath)} ariaLabel={t('file.revealInFolder')} title={t('file.revealInFolder')} />
  }
  if (action === 'download') {
    return <IconButton icon="download" iconSize={22} iconClassName="text-secondary" onClick={() => onDownload(relPath)} ariaLabel={t('file.download')} title={t('file.download')} />
  }
  if (action === 'download-disabled') {
    return <IconButton icon="download" iconSize={22} iconClassName="text-secondary" onClick={() => undefined} ariaLabel={t('file.downloadUnavailable')} title={t('file.downloadUnavailable')} disabled />
  }
  if (action === 'busy') {
    return (
      <span role="status" aria-live="polite" className="w-10 h-10 flex items-center justify-center">
        <Icon name="update" className="text-on-surface-variant animate-pulse" />
        <span className="sr-only">{busyLabel}</span>
      </span>
    )
  }
  return <div className="w-10 h-10" />
}

function ShareFileRow({ file, isOwn, manualControls, spaceId, members, downloadSummary, onDownload, onReveal, onPause, onCancel, onDiscardPartial, displayName, leadingGutter }: ShareFileRowProps) {
  const { t } = useTranslation()
  const { t: tErr } = useTranslation('errors')
  const isDownloading = file.status === 'downloading'
  // Indexing, not transferring: the owner hashes its own file ('publishing'), and a member
  // watching that file waits on the same hash ('preparing'). Neither moves bytes to this device,
  // so both stay out of the download lane and off its "Download progress" meter.
  const isPreparing = file.status === 'preparing'
  const isPublishing = file.status === 'publishing'
  const isIndexing = isPreparing || isPublishing
  // Verifying is a display sub-phase of an active (server-derived) download, carried on the
  // decoration — not a status the renderer sets. Parity with the loose FileCard path.
  const isVerifying = isDownloading && file.progress?.phase === 'verifying'
  const verifyPct = file.verifyFraction != null ? Math.round(file.verifyFraction * 100) : 0
  const isPausedInterrupted = file.status === 'paused-interrupted'
  const isPausedOffline = file.status === 'paused-offline'
  const transferId = file.transferId
  // Until the first byte (owner indexing + connection setup) show "Preparing…", not
  // a 0% bar — gives feedback during the gap and matches the space-root path.
  const waiting = isDownloading && (file.progress?.bytes ?? 0) === 0
  const badge = badgeStyle(shareFileStatusToBadge(isVerifying ? 'verifying' : waiting ? 'preparing' : file.status, isOwn))
  const pausedBytes = (isPausedInterrupted || isPausedOffline) ? file.pendingBytes : undefined
  const showDownloadProgressBar = isDownloading && !waiting && file.progress != null && file.progress.total > 0
  const showIndexProgressBar = isIndexing && file.progress != null && file.progress.total > 0
  const progressEta = resolveEta(file.progress?.eta, file.progress?.avgSpeed)
  const showPausedProgressBar = (isPausedInterrupted || isPausedOffline)
    && pausedBytes != null && pausedBytes > 0 && file.size > 0
  const action = fileRowAction({ status: file.status, manualControls, hasTransferId: !!transferId })
  const busyLabel = isPublishing ? t('status.publishing') : isPreparing ? t('file.preparing') : t('file.syncing')

  // Sender-side download indicator: who is currently pulling this file from us. Only
  // shown on an owned share's row at rest — a competing progress branch takes
  // precedence, and the dropdown is gated on the same condition so it can't orphan.
  // Mirrors FileCard's loose-file indicator (downloadSummary is null for non-owners).
  const [showDownloaders, setShowDownloaders] = useState(false)
  const reactId = useId()
  const dropdownId = `peer-downloads-${reactId}`
  const hasDownloaders = (downloadSummary?.peerKeys.length ?? 0) > 0
  const inProgressBranch = showDownloadProgressBar || showIndexProgressBar || showPausedProgressBar || isVerifying
  const indicatorActive = hasDownloaders && !inProgressBranch
  useEffect(() => {
    if (!indicatorActive) setShowDownloaders(false)
  }, [indicatorActive])

  return (
    <div className="group @container/row bg-surface-container-lowest dark:bg-surface-container-low hover:bg-surface-container-highest dark:hover:bg-surface-container-highest rounded-xl transition-colors">
      <div className="flex items-center p-5">
      {leadingGutter && <span className="w-5 shrink-0" aria-hidden="true" />}
      <div className={`flex items-center gap-4 min-w-0 flex-grow${leadingGutter ? ' ml-4' : ''}`}>
        <div className="w-12 h-12 bg-surface-container-high rounded-lg flex items-center justify-center shrink-0">
          <Icon name={getFileIcon(file.relPath)} className="text-accent" />
        </div>
        <div className="min-w-0 flex-grow">
          <FileName name={file.relPath} displayName={displayName} className="font-bold text-accent" />
          <p className="text-xs text-on-surface-variant mt-0.5 truncate">{formatSize(file.size)}</p>
          {file.status === 'error' && (
            <p role="alert" className="text-xs text-error mt-1">{tErr(errorCodeToI18nKey(file.errorCode))}</p>
          )}
        </div>
      </div>
      {isVerifying ? (
        <>
          <div className="ml-6 basis-32 shrink-0 self-center">
            <DownloadProgressLane value={verifyPct} label={t('status.verifying')} showPct />
          </div>
          <div className="ml-5 mr-3 shrink-0 self-center items-center hidden @min-[480px]/row:flex">
            <Badge label={t(badge.labelKey)} classes={badge.classes} />
          </div>
        </>
      ) : showIndexProgressBar && file.progress ? (
        <>
          <div className="ml-6 basis-32 shrink-0 self-center">
            <DownloadProgressLane
              value={Math.min(100, Math.round((file.progress.bytes / file.progress.total) * 100))}
              label={t('file.indexingProgress')}
              eta={progressEta.etaText}
              indeterminate={progressEta.indeterminate}
            />
          </div>
          <div className="ml-5 mr-3 shrink-0 self-center items-center hidden @min-[480px]/row:flex">
            <Badge label={t(badge.labelKey)} classes={badge.classes} />
          </div>
        </>
      ) : showDownloadProgressBar && file.progress ? (
        <>
          <div className="ml-6 basis-40 shrink-0 self-center">
            <DownloadProgressLane
              value={Math.min(100, Math.round((file.progress.bytes / file.progress.total) * 100))}
              label={t('file.downloadProgress')}
              speed={file.progress.avgSpeed != null ? formatSpeed(file.progress.avgSpeed) : undefined}
              eta={progressEta.etaText}
              indeterminate={progressEta.indeterminate}
            />
          </div>
          <div className="ml-5 mr-3 shrink-0 self-center items-center hidden @min-[480px]/row:flex">
            <Badge label={t(badge.labelKey)} classes={badge.classes} />
          </div>
        </>
      ) : showPausedProgressBar && pausedBytes != null ? (
        <>
          <div className="ml-6 basis-32 shrink-0 self-center">
            <DownloadProgressLane
              value={Math.min(100, Math.round((pausedBytes / file.size) * 100))}
              label={t('file.downloadProgress')}
              bytes={formatSize(pausedBytes)}
            />
          </div>
          <div className="ml-5 mr-3 shrink-0 self-center items-center hidden @min-[480px]/row:flex">
            <Badge label={t(badge.labelKey)} classes={badge.classes} />
          </div>
        </>
      ) : indicatorActive && downloadSummary ? (
        <>
          <div className="ml-6 basis-72 shrink-[2] min-w-[180px] self-center">
            <PeerDownloadIndicator
              summary={downloadSummary}
              members={members}
              open={showDownloaders}
              onToggle={() => setShowDownloaders((v) => !v)}
              controlsId={dropdownId}
            />
          </div>
          <div className="ml-5 mr-3 shrink-0 self-center items-center hidden @min-[480px]/row:flex">
            <Badge label={t('file.sending')} classes="bg-info text-accent" />
          </div>
        </>
      ) : (
        <div className="shrink-0 ml-6 mr-3 flex items-center gap-2 self-center">
          {file.verified && <VerifiedCheck label={t('file.verified')} />}
          <Badge label={t(badge.labelKey)} classes={badge.classes} />
        </div>
      )}
      {/* Right edge is actions only; the verified badge is information and sits with
          the status pill above (so pills stay right-aligned across rows). */}
      <div className="flex items-center gap-1 shrink-0">
        <FileRowActions
          action={action}
          relPath={file.relPath}
          transferId={transferId}
          busyLabel={busyLabel}
          onDownload={onDownload}
          onReveal={onReveal}
          onPause={onPause}
          onCancel={onCancel}
          onDiscardPartial={onDiscardPartial}
        />
      </div>
      </div>
      {indicatorActive && showDownloaders && downloadSummary && (
        <div className="pb-2">
          <PeerDownloadDropdown
            id={dropdownId}
            spaceId={spaceId}
            path={file.relPath}
            members={members}
          />
        </div>
      )}
    </div>
  )
}

// Same reason as FileCard: the folder tree's rows must not repaint on every decoration heartbeat.
// `file` keeps its identity across a listing refetch (shareFilesReconcile.js), `members` is the
// memoized roster, `downloadSummary` is a per-path Map value, and the five handlers are stable.
export default memo(ShareFileRow)
