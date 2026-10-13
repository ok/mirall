// One file row in a folder share: transfer status/progress, per-file actions, and the
// owner-side who-is-downloading and who-has-it indicators. Extracted from FolderScreen so the
// collapsible tree and the flat list can share it.
import InlineError from '../primitives/InlineError.js'
import { memo, useState, useId, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import Icon from '../primitives/Icon.js'
import ActionLane from './ActionLane.js'
import PeerDownloadDropdown from './PeerDownloadDropdown.js'
import RowLane from './RowLane.js'
import FileName from '../primitives/FileName.js'
import { formatSize, getFileIcon } from '../../format/utils.js'
import { errorCodeToI18nKey } from '../../errors/error-messages.js'
import { deriveRowView } from '../../model/row-view.js'
import { recipientSummary } from '../../model/file-recipients.js'
import type { Decoration } from '../../types/ui.js'
import type { ShareFileRow as ShareFileRowData, SpaceMember, PeerDownloadSummary, FileRecipient } from '../../types/types.js'

// test seam
export interface ShareFileRowProps {
  file: ShareFileRowData
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
  recipients: FileRecipient[]
  ownerKey: string
  onDownload: (relPath: string) => void
  onReveal: (relPath: string) => void
  onPause: (transferId: string) => void
  onCancel: (transferId: string) => void
  displayName?: string
  leadingGutter?: boolean
}

function ShareFileRow({ file, decoration, seeded, isOwn, manualControls, spaceId, members, downloadSummary, recipients, ownerKey, onDownload, onReveal, onPause, onCancel, displayName, leadingGutter }: ShareFileRowProps) {
  const { t } = useTranslation()
  const { t: tErr } = useTranslation('errors')
  const rowName = displayName || file.relPath
  const view = deriveRowView(file, decoration, downloadSummary, { isOwn, seeded })

  const holders = useMemo(
    () => (isOwn ? recipientSummary({ recipients, contentHash: file.hash, members, ownerKey }) : null),
    [isOwn, recipients, file.hash, members, ownerKey],
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

  return (
    <div className="group @container/row bg-surface-container-lowest dark:bg-surface-container-low hover:bg-surface-container-highest dark:hover:bg-surface-container-highest hover:[--control-hover:var(--lifted-control-hover)] rounded-xl transition-colors">
      <div className="flex items-center p-5">
        {leadingGutter && <span className="w-5 shrink-0" aria-hidden="true" />}
        <div role="none" title={file.relPath} className={`flex items-center gap-4 min-w-0 flex-grow${leadingGutter ? ' ml-4' : ''}`}>
          <div className="w-12 h-12 bg-surface-container-high rounded-lg flex items-center justify-center shrink-0">
            <Icon name={getFileIcon(file.relPath)} className="text-accent" />
          </div>
          <div className="min-w-0 flex-grow">
            <FileName name={file.relPath} displayName={displayName} className="font-bold text-accent" />
            <p className="text-xs text-on-surface-variant mt-0.5 truncate">{formatSize(file.size)}</p>
            {view.statusHintKey && <p className="text-xs text-on-surface-variant mt-1">{t(view.statusHintKey)}</p>}
            {file.status === 'error' && (
              <InlineError size="xs" className="mt-1">{tErr(errorCodeToI18nKey(file.errorCode))}</InlineError>
            )}
          </div>
        </div>
        <RowLane
          view={view}
          rowName={rowName}
          kind="share"
          members={members}
          downloadSummary={downloadSummary}
          recipients={holders}
          showDownloaders={showDownloaders}
          onToggleDownloaders={() => setShowDownloaders((v) => !v)}
          dropdownId={dropdownId}
        />
        <ActionLane
          row={file}
          context={{ isOwn, manualControls, ownerFileVerbs: false }}
          verbs={{
            download: () => onDownload(file.relPath),
            reveal: () => onReveal(file.relPath),
            pause: () => file.transferId && onPause(file.transferId),
            cancel: () => file.transferId && onCancel(file.transferId),
            resume: () => onDownload(file.relPath),
            discard: () => file.transferId && onCancel(file.transferId),
            retry: () => onDownload(file.relPath),
            dismiss: () => file.transferId && onCancel(file.transferId),
          }}
        />
      </div>
      {listable && showDownloaders && (
        // The dropdown lines up with the icon tile, so it takes the leading gutter's indent too.
        <div className={`pb-2${leadingGutter ? ' pl-9' : ''}`}>
          <PeerDownloadDropdown
            id={dropdownId}
            spaceId={spaceId}
            path={file.relPath}
            members={members}
            recipients={isOwn ? recipients : []}
            contentHash={file.hash}
            ownerKey={ownerKey}
          />
        </div>
      )}
    </div>
  )
}

// memo against the decoration heartbeat (src/renderer/hooks/README.md): `file` is identity-reconciled,
// `members` memoized, decoration/downloadSummary/recipients per-path Map values, the five handlers stable.
export default memo(ShareFileRow)
