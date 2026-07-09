// A file row in a space's list: derives the action buttons from file status and swaps the
// right-hand lane between publish/verify/download progress, the who-is-downloading indicator, and the status pill.
import { useState, useEffect, useId } from 'react'
import { useTranslation } from 'react-i18next'
import { formatSize, getFileIcon, fileName } from '../../utils.js'
import { errorCodeToI18nKey } from '../../errorMessages.js'
import { deriveFileCardView } from '../../fileCardView.js'
import type { FileEntry, SpaceMember, PeerDownloadSummary } from '../../types.js'
import type { Decoration } from '../../hooks/useDecorations.js'
import FileName from '../widgets/FileName.js'
import FileCardLane from './FileCardLane.js'
import PeerDownloadDropdown from './PeerDownloadDropdown.js'
import Icon, { type IconName } from '../primitives/Icon.js'

interface FileCardProps {
  file: FileEntry
  decoration: Decoration | null
  onDownload: (file: FileEntry) => void
  onCancel: (transferId: string) => void
  onPause: (transferId: string) => void
  onReveal: (file: FileEntry) => void
  onUnshare: (file: FileEntry) => void
  onDiscardPartial: (file: FileEntry) => void
  onCancelPublish: (file: FileEntry) => void
  members?: SpaceMember[]
  downloadSummary?: PeerDownloadSummary | null
}

type ActionVariant = 'default' | 'danger'

interface ActionButton {
  icon: IconName
  title: string
  onClick: () => void
  variant?: ActionVariant
}

interface ActionPair {
  primary: ActionButton | null
  secondary: ActionButton | null
}

function deriveActions(
  file: FileEntry,
  t: (key: string) => string,
  handlers: {
    onDownload: (file: FileEntry) => void
    onCancel: (transferId: string) => void
    onPause: (transferId: string) => void
    onReveal: (file: FileEntry) => void
    onUnshare: (file: FileEntry) => void
    onDiscardPartial: (file: FileEntry) => void
    onCancelPublish: (file: FileEntry) => void
  }
): ActionPair {
  switch (file.status) {
    case 'mine':
      return {
        primary: { icon: 'folder_open', title: t('file.revealInFolder'), onClick: () => handlers.onReveal(file) },
        secondary: { icon: 'delete', title: t('file.unshare'), onClick: () => handlers.onUnshare(file), variant: 'danger' },
      }
    case 'downloaded':
      return {
        primary: { icon: 'folder_open', title: t('file.revealInFolder'), onClick: () => handlers.onReveal(file) },
        secondary: null,
      }
    case 'remote':
      return {
        primary: { icon: 'download', title: t('file.download'), onClick: () => handlers.onDownload(file) },
        secondary: null,
      }
    case 'preparing':
      return { primary: null, secondary: null }
    case 'verifying':
    case 'downloading':
      return {
        primary: {
          icon: 'pause',
          title: t('file.pause'),
          onClick: () => handlers.onPause(file.transferId ?? ''),
        },
        // Loose downloads can be stopped outright (discard the partial).
        secondary: file.inPlace
          ? { icon: 'close', title: t('file.cancel'), onClick: () => handlers.onCancel(file.transferId ?? ''), variant: 'danger' }
          : null,
      }
    case 'publishing':
      return {
        primary: {
          icon: 'close',
          title: t('file.cancel'),
          onClick: () => handlers.onCancelPublish(file),
          variant: 'danger',
        },
        secondary: null,
      }
    case 'paused-interrupted':
      return {
        primary: { icon: 'play_arrow', title: t('file.resume'), onClick: () => handlers.onDownload(file) },
        secondary: { icon: 'close', title: t('file.discardPartial'), onClick: () => handlers.onDiscardPartial(file) },
      }
    case 'paused-offline':
      return {
        primary: { icon: 'close', title: t('file.discardPartial'), onClick: () => handlers.onDiscardPartial(file) },
        secondary: null,
      }
    case 'unavailable':
      return { primary: null, secondary: null }
    case 'error':
      return {
        primary: { icon: 'refresh', title: t('file.retry'), onClick: () => handlers.onDownload(file) },
        secondary: { icon: 'close', title: t('file.dismiss'), onClick: () => handlers.onDiscardPartial(file) },
      }
  }
}

function ActionSlot({
  action,
  alwaysVisible,
}: {
  action: ActionButton | null
  alwaysVisible: boolean
}) {
  if (!action) return <div className="w-10 h-10" />
  const isDanger = action.variant === 'danger'
  const visibility = alwaysVisible
    ? ''
    : 'opacity-0 group-hover:opacity-100 focus:opacity-100'
  const hoverBg = isDanger ? 'hover:bg-error-container' : 'hover:bg-surface-container-high'
  const iconColor = isDanger ? 'text-error' : 'text-secondary'
  return (
    <button
      onClick={action.onClick}
      title={action.title}
      aria-label={action.title}
      className={`w-10 h-10 flex items-center justify-center rounded-full ${hoverBg} active:scale-95 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 ${visibility}`}
    >
      <Icon name={action.icon} size={22} className={iconColor} />
    </button>
  )
}

export default function FileCard({
  file,
  decoration,
  onDownload,
  onCancel,
  onPause,
  onReveal,
  onUnshare,
  onDiscardPartial,
  onCancelPublish,
  members,
  downloadSummary,
}: FileCardProps) {
  const { t } = useTranslation()
  const { t: tErr } = useTranslation('errors')
  const view = deriveFileCardView(file, decoration, downloadSummary)

  // The dropdown is gated on the same indicator condition so it can't orphan when a
  // competing progress branch wins the lane.
  const [showDownloaders, setShowDownloaders] = useState(false)
  const reactId = useId()
  const dropdownId = `peer-downloads-${reactId}`
  useEffect(() => {
    if (!view.indicatorActive) setShowDownloaders(false)
  }, [view.indicatorActive])

  const { primary, secondary } = deriveActions(file, t, {
    onDownload,
    onCancel,
    onPause,
    onReveal,
    onUnshare,
    onDiscardPartial,
    onCancelPublish,
  })

  const sharedByLabel =
    file.sharedByCount && file.sharedByCount > 0
      ? t('file.alsoSharedBy', { count: file.sharedByCount })
      : ''

  const errorKey = errorCodeToI18nKey(file.errorCode)

  return (
    <div className="group @container/row bg-surface-container-lowest dark:bg-surface-container-low hover:bg-surface-container-highest dark:hover:bg-surface-container-highest rounded-xl transition-colors">
      <div className="flex items-center p-5">
      <div className="flex items-center gap-4 min-w-0 flex-grow">
        <div className="w-12 h-12 bg-surface-container-high rounded-lg flex items-center justify-center shrink-0">
          <Icon name={getFileIcon(file.path)} className="text-accent" />
        </div>
        <div className="min-w-0 flex-grow">
          <FileName name={fileName(file.path)} className="font-bold text-accent" />
          <p className="text-xs text-on-surface-variant truncate">
            {formatSize(file.size)} • {t('file.sharedBy', { name: file.owner?.displayName || t('file.unknownOwner') })}{sharedByLabel}
            {/* Error rides the meta line (not a row of its own) so a failed row
                keeps the resting card height. */}
            {file.status === 'error' && (
              <>
                {' • '}
                <span role="alert" className="text-error">{tErr(errorKey)}</span>
              </>
            )}
          </p>
        </div>
      </div>

      <FileCardLane
        view={view}
        members={members}
        downloadSummary={downloadSummary}
        showDownloaders={showDownloaders}
        onToggleDownloaders={() => setShowDownloaders((v) => !v)}
        dropdownId={dropdownId}
      />
      {/* Right edge is actions only; the two-slot strip keeps a constant width so
          the status pills stay right-aligned across rows regardless of status. */}
      <div className="flex items-center gap-1 shrink-0">
        <ActionSlot action={secondary} alwaysVisible={false} />
        <ActionSlot action={primary} alwaysVisible={true} />
      </div>
      </div>
      {view.indicatorActive && showDownloaders && downloadSummary && (
        <div className="pb-2">
          <PeerDownloadDropdown
            id={dropdownId}
            spaceId={downloadSummary.spaceId}
            path={file.path}
            members={members ?? []}
          />
        </div>
      )}
    </div>
  )
}
