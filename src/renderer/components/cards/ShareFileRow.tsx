// One file row in a folder share: transfer status/progress, per-file actions, and the
// owner-side who-is-downloading indicator. Extracted from FolderView so the collapsible
// tree and the flat list can share it.
import { memo, useState, useId, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import Icon from '../primitives/Icon.js'
import IconButton from '../primitives/IconButton.js'
import PeerDownloadDropdown from './PeerDownloadDropdown.js'
import RowLane from './RowLane.js'
import FileName from '../widgets/FileName.js'
import { formatSize, getFileIcon } from '../../utils.js'
import { errorCodeToI18nKey } from '../../errorMessages.js'
import { fileRowAction } from '../../fileRowAction.js'
import { deriveRowView } from '../../rowView.js'
import type { Decoration } from '../../hooks/useDecorations.js'
import type { ShareFileEntry, SpaceMember, PeerDownloadSummary } from '../../types.js'

export interface ShareFileRowProps {
  file: ShareFileEntry
  /** This row's live transfer frame, looked up by useShareFiles. Two scalar props rather than one
      object: an object literal would be a fresh identity every render and defeat the memo below. */
  decoration: Decoration | null
  /** The download was just requested and no decoration has arrived yet. */
  seeded: boolean
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

function ShareFileRow({ file, decoration, seeded, isOwn, manualControls, spaceId, members, downloadSummary, onDownload, onReveal, onPause, onCancel, onDiscardPartial, displayName, leadingGutter }: ShareFileRowProps) {
  const { t } = useTranslation()
  const { t: tErr } = useTranslation('errors')
  const rowName = displayName || file.relPath
  const view = deriveRowView(file, decoration, downloadSummary, { kind: 'share', isOwn, seeded })

  const action = fileRowAction({ status: file.status, manualControls, hasTransferId: !!file.transferId })
  const busyLabel = file.status === 'publishing'
    ? t('status.publishing')
    : file.status === 'preparing' ? t('file.preparing') : t('file.syncing')

  // The dropdown is gated on the same indicator condition as the lane, so it can't orphan when a
  // competing progress branch wins.
  const [showDownloaders, setShowDownloaders] = useState(false)
  const reactId = useId()
  const dropdownId = `peer-downloads-${reactId}`
  useEffect(() => {
    if (!view.indicatorActive) setShowDownloaders(false)
  }, [view.indicatorActive])

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
      <RowLane
        view={view}
        rowName={rowName}
        kind="share"
        members={members}
        downloadSummary={downloadSummary}
        showDownloaders={showDownloaders}
        onToggleDownloaders={() => setShowDownloaders((v) => !v)}
        dropdownId={dropdownId}
      />
      {/* Right edge is actions only; the verified badge is information and sits with
          the status pill above (so pills stay right-aligned across rows). */}
      <div className="flex items-center gap-1 shrink-0">
        <FileRowActions
          action={action}
          relPath={file.relPath}
          transferId={file.transferId}
          busyLabel={busyLabel}
          onDownload={onDownload}
          onReveal={onReveal}
          onPause={onPause}
          onCancel={onCancel}
          onDiscardPartial={onDiscardPartial}
        />
      </div>
      </div>
      {view.indicatorActive && showDownloaders && downloadSummary && (
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
// memoized roster, `decoration` and `downloadSummary` are per-path Map values, and the five
// handlers are stable.
export default memo(ShareFileRow)
