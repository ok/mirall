// A file row in a space's list: the action strip comes from ActionLane, and the row swaps the
// right-hand lane between publish/verify/download progress, the who-is-downloading indicator, and the
// status pill with who already has it.
import { memo, useState, useEffect, useId, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { formatSize, getFileIcon, fileName } from '../../format/utils.js'
import { errorCodeToI18nKey } from '../../errors/error-messages.js'
import { deriveRowView } from '../../model/row-view.js'
import { recipientSummary } from '../../model/file-recipients.js'
import type { FileEntry, SpaceMember, PeerDownloadSummary, FileRecipient } from '../../types/types.js'
import type { Decoration } from '../../types/ui.js'
import FileName from '../primitives/FileName.js'
import RowLane from './RowLane.js'
import PeerDownloadDropdown from './PeerDownloadDropdown.js'
import Icon from '../primitives/Icon.js'
import ActionLane from './ActionLane.js'

interface FileCardProps {
  file: FileEntry
  /** The row is one of our own files: it reads "Shared by you" and offers unshare. */
  isOwn: boolean
  decoration: Decoration | null
  /** The download was just requested and no decoration has arrived yet. */
  seeded: boolean
  onDownload: (file: FileEntry) => void
  onCancel: (transferId: string) => void
  onPause: (transferId: string) => void
  onReveal: (file: FileEntry) => void
  onUnshare: (file: FileEntry) => void
  onCancelPublish: (file: FileEntry) => void
  spaceId: string
  members?: SpaceMember[]
  downloadSummary?: PeerDownloadSummary | null
  recipients: FileRecipient[]
}

function FileCard({
  file,
  isOwn,
  decoration,
  seeded,
  onDownload,
  onCancel,
  onPause,
  onReveal,
  onUnshare,
  onCancelPublish,
  spaceId,
  members,
  downloadSummary,
  recipients,
}: FileCardProps) {
  const { t } = useTranslation()
  const { t: tErr } = useTranslation('errors')
  const rowName = fileName(file.path)
  const view = deriveRowView(file, decoration, downloadSummary, { isOwn, seeded })

  const holders = useMemo(
    () => (isOwn ? recipientSummary({ recipients, contentHash: file.hash, members: members ?? [], ownerKey: file.owner.publicKey }) : null),
    [isOwn, recipients, file.hash, members, file.owner.publicKey],
  )

  // The dropdown is gated on whichever toggle the lane shows — the peer list, or the recipients on the
  // resting lane — so it can't orphan when a competing progress branch wins the lane.
  const [showDownloaders, setShowDownloaders] = useState(false)
  const reactId = useId()
  const dropdownId = `peer-downloads-${reactId}`
  const listable = view.peerListActive || (holders !== null && view.lane === 'rest')
  useEffect(() => {
    if (!listable) setShowDownloaders(false)
  }, [listable])

  const sharedByLabel =
    file.sharedByCount && file.sharedByCount > 0
      ? t('file.alsoSharedBy', { count: file.sharedByCount })
      : ''

  const errorKey = errorCodeToI18nKey(file.errorCode)

  return (
    <div className="group @container/row bg-surface-container-lowest dark:bg-surface-container-low hover:bg-surface-container-highest dark:hover:bg-surface-container-highest hover:[--control-hover:var(--lifted-control-hover)] rounded-xl transition-colors">
      <div className="flex items-center p-5">
        <div role="none" title={rowName} className="flex items-center gap-4 min-w-0 flex-grow">
          <div className="w-12 h-12 bg-surface-container-high rounded-lg flex items-center justify-center shrink-0">
            <Icon name={getFileIcon(file.path)} className="text-accent" />
          </div>
          <div className="min-w-0 flex-grow">
            <FileName name={rowName} className="font-bold text-accent" />
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
            {view.statusHintKey && <p className="text-xs text-on-surface-variant mt-1">{t(view.statusHintKey)}</p>}
          </div>
        </div>

        <RowLane
          view={view}
          rowName={rowName}
          kind="loose"
          members={members}
          downloadSummary={downloadSummary}
          recipients={holders}
          showDownloaders={showDownloaders}
          onToggleDownloaders={() => setShowDownloaders((v) => !v)}
          dropdownId={dropdownId}
        />
        <ActionLane
          row={file}
          context={{ isOwn, manualControls: true, ownerFileVerbs: true }}
          verbs={{
            download: () => onDownload(file),
            reveal: () => onReveal(file),
            unshare: () => onUnshare(file),
            'cancel-publish': () => onCancelPublish(file),
            pause: () => file.transferId && onPause(file.transferId),
            cancel: () => file.transferId && onCancel(file.transferId),
            resume: () => onDownload(file),
            discard: () => file.transferId && onCancel(file.transferId),
            retry: () => onDownload(file),
            dismiss: () => file.transferId && onCancel(file.transferId),
          }}
        />
      </div>
      {listable && showDownloaders && (
        <div className="pb-2">
          <PeerDownloadDropdown
            id={dropdownId}
            spaceId={spaceId}
            path={file.path}
            members={members ?? []}
            recipients={isOwn ? recipients : []}
            contentHash={file.hash}
            ownerKey={file.owner.publicKey}
          />
        </div>
      )}
    </div>
  )
}

// memo against the decoration heartbeat: every prop is identity-stable (src/renderer/hooks/README.md).
export default memo(FileCard)
