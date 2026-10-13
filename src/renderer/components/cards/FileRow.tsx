// One file in a list: a loose file on the space screen, or a file in a folder share's tree. The tile,
// the lane and the action strip are one; what differs by kind is the row's identity, the owner line a
// loose file carries, the tree's leading gutter, and whether the owner may withdraw one file.
import { memo, useState, useEffect, useId, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { formatSize, getFileIcon, fileName } from '../../format/utils.js'
import { errorCodeToI18nKey } from '../../errors/error-messages.js'
import { deriveRowView } from '../../model/row-view.js'
import { recipientSummary } from '../../model/file-recipients.js'
import type { FileEntry, ShareFileRow, SpaceMember, PeerDownloadSummary, FileRecipient } from '../../types/types.js'
import type { Decoration } from '../../types/ui.js'
import FileName from '../primitives/FileName.js'
import Icon from '../primitives/Icon.js'
import RowLane from './RowLane.js'
import ActionLane, { type ActionLaneProps } from './ActionLane.js'
import PeerDownloadDropdown from './PeerDownloadDropdown.js'

interface FileRowShared {
  /** This row's live transfer frame. */
  decoration: Decoration | null
  /** The download was just requested and no decoration has arrived yet. */
  seeded: boolean
  /** The row is one of our own files: it reads "Shared by you" and lists who has it. */
  isOwn: boolean
  spaceId: string
  members: SpaceMember[]
  downloadSummary: PeerDownloadSummary | null
  recipients: FileRecipient[]
  onPause: (transferId: string) => void
  onCancel: (transferId: string) => void
}

export interface LooseFileRowProps extends FileRowShared {
  kind: 'loose'
  file: FileEntry
  onDownload: (file: FileEntry) => void
  onReveal: (file: FileEntry) => void
  onUnshare: (file: FileEntry) => void
  onCancelPublish: (file: FileEntry) => void
}

export interface ShareFileRowProps extends FileRowShared {
  kind: 'share'
  file: ShareFileRow
  /** The name shown in the tree; the full relative path stays the accessible name. */
  displayName: string
  /** False on a mirrored folder, whose rows sync themselves. */
  manualControls: boolean
  ownerKey: string
  onDownload: (relPath: string) => void
  onReveal: (relPath: string) => void
}

export type FileRowProps = LooseFileRowProps | ShareFileRowProps

interface RowIdentity {
  /** The key the row's verbs and lookups take: the drive path, or the path in the share. */
  key: string
  name: string
  shownName?: string
  rowName: string
  ownerKey: string
}

function rowIdentity(props: FileRowProps): RowIdentity {
  if (props.kind === 'loose') {
    const name = fileName(props.file.path)
    return { key: props.file.path, name, rowName: name, ownerKey: props.file.owner.publicKey }
  }
  const { relPath } = props.file
  return { key: relPath, name: relPath, shownName: props.displayName, rowName: props.displayName || relPath, ownerKey: props.ownerKey }
}

// The table offers pause, cancel, discard and dismiss only on a row with a transfer, so the
// transfer verbs need no fallback of their own.
function actionLane(props: FileRowProps): ActionLaneProps {
  const { isOwn } = props
  const { transferId } = props.file
  const stop = () => { if (transferId) props.onCancel(transferId) }
  const transfer = { pause: () => { if (transferId) props.onPause(transferId) }, cancel: stop, discard: stop, dismiss: stop }
  if (props.kind === 'loose') {
    const { file, onDownload, onReveal, onUnshare, onCancelPublish } = props
    const fetch = () => onDownload(file)
    return {
      row: file,
      context: { isOwn, manualControls: true, ownerFileVerbs: true },
      verbs: { ...transfer, download: fetch, resume: fetch, retry: fetch, reveal: () => onReveal(file), unshare: () => onUnshare(file), 'cancel-publish': () => onCancelPublish(file) },
    }
  }
  const { file, manualControls, onDownload, onReveal } = props
  const fetch = () => onDownload(file.relPath)
  return {
    row: file,
    context: { isOwn, manualControls, ownerFileVerbs: false },
    verbs: { ...transfer, download: fetch, resume: fetch, retry: fetch, reveal: () => onReveal(file.relPath) },
  }
}

/** Who shared a loose file; a folder file's owner is the folder's. */
function ownerLine(props: FileRowProps, t: TFunction): string | null {
  if (props.kind !== 'loose') return null
  const { owner, sharedByCount } = props.file
  const also = sharedByCount && sharedByCount > 0 ? t('file.alsoSharedBy', { count: sharedByCount }) : ''
  return t('file.sharedBy', { name: owner?.displayName || t('file.unknownOwner') }) + also
}

interface FileRowMetaProps {
  size: number
  owner: string | null
  error: string | null
}

// The error rides the meta line rather than a line of its own, so a failed row keeps its resting
// height. The line truncates; the alert holds the whole message as one node either way.
function FileRowMeta({ size, owner, error }: FileRowMetaProps) {
  return (
    <p className="text-xs text-on-surface-variant mt-0.5 truncate">
      {owner ? `${formatSize(size)} • ${owner}` : formatSize(size)}
      {error && (
        <>
          {' • '}
          <span role="alert" className="text-error">{error}</span>
        </>
      )}
    </p>
  )
}

function FileRow(props: FileRowProps) {
  const { t } = useTranslation()
  const { t: tErr } = useTranslation('errors')
  const { kind, file, decoration, seeded, isOwn, spaceId, members, downloadSummary, recipients } = props
  const id = rowIdentity(props)
  const view = deriveRowView(file, decoration, downloadSummary, { isOwn, seeded })

  const holders = useMemo(
    () => (isOwn ? recipientSummary({ recipients, contentHash: file.hash, members, ownerKey: id.ownerKey }) : null),
    [isOwn, recipients, file.hash, members, id.ownerKey],
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

  const tree = kind === 'share'
  const error = file.status === 'error' ? tErr(errorCodeToI18nKey(file.errorCode)) : null

  return (
    <div className="group @container/row bg-surface-container-lowest dark:bg-surface-container-low hover:bg-surface-container-highest dark:hover:bg-surface-container-highest hover:[--control-hover:var(--lifted-control-hover)] rounded-xl transition-colors">
      <div className="flex items-center p-5">
        {tree && <span className="w-5 shrink-0" aria-hidden="true" />}
        <div role="none" title={id.name} className={`flex items-center gap-4 min-w-0 flex-grow${tree ? ' ml-4' : ''}`}>
          <div className="w-12 h-12 bg-surface-container-high rounded-lg flex items-center justify-center shrink-0">
            <Icon name={getFileIcon(id.key)} className="text-accent" />
          </div>
          <div className="min-w-0 flex-grow">
            <FileName name={id.name} displayName={id.shownName} className="font-bold text-accent" />
            <FileRowMeta size={file.size} owner={ownerLine(props, t)} error={error} />
            {view.statusHintKey && <p className="text-xs text-on-surface-variant mt-1">{t(view.statusHintKey)}</p>}
          </div>
        </div>
        <RowLane
          view={view}
          rowName={id.rowName}
          kind={kind}
          members={members}
          downloadSummary={downloadSummary}
          recipients={holders}
          showDownloaders={showDownloaders}
          onToggleDownloaders={() => setShowDownloaders((v) => !v)}
          dropdownId={dropdownId}
        />
        <ActionLane {...actionLane(props)} />
      </div>
      {listable && showDownloaders && (
        // The dropdown lines up with the icon tile, so in a tree it takes the leading gutter's indent.
        <div className={`pb-2${tree ? ' pl-9' : ''}`}>
          <PeerDownloadDropdown
            id={dropdownId}
            spaceId={spaceId}
            path={id.key}
            members={members}
            recipients={isOwn ? recipients : []}
            contentHash={file.hash}
            ownerKey={id.ownerKey}
          />
        </div>
      )}
    </div>
  )
}

// memo against the decoration heartbeat (src/renderer/hooks/README.md): every prop is identity-stable
// — `file` reconciled, `members` memoized, decoration/downloadSummary/recipients per-path Map values,
// the handlers stable — and the action lane's props are built inside, never passed in.
export default memo(FileRow)
