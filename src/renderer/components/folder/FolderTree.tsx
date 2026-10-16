// Recursive renderer for the collapsible FolderScreen tree: folders are disclosure
// buttons (aria-expanded + aria-controls) over FileRow leaves. While the selection column is open
// a folder row draws a tri-state box beside its button, never inside it, and a modified click on
// the row selects instead of expanding.
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import Icon from '../primitives/Icon.js'
import Badge from '../primitives/Badge.js'
import FileName from '../primitives/FileName.js'
import FileRow from '../cards/FileRow.js'
import type { DownloadTo } from '../../hooks/useDownloadTo.js'
import SelectBox from '../batch/SelectBox.js'
import { formatSize } from '../../format/utils.js'
import { badgeStyle } from '../../model/status-badge.js'
import { dirId, gestureOf, triState, type Gesture } from '../../model/batch-selection.js'
import type { Decoration } from '../../types/ui.js'
import type { FileTreeNode, FileTreeFolderNode, SpaceMember, PeerDownloadSummary, FileRecipient } from '../../types/types.js'

const NO_RECIPIENTS: FileRecipient[] = []

/** What a tree needs from a listing that offers selection. Null on a listing that does not. */
export interface TreeSelection {
  mode: boolean
  selected: ReadonlySet<string>
  /** The file keys a box is offered for: matching, and with something a batch can do. */
  selectable: ReadonlySet<string>
  /** The matching file keys below a folder path. */
  filesUnder: (path: string) => readonly string[]
  /** A row-body or folder-row gesture; false when it was not a selection gesture. */
  select: (id: string, gesture: Gesture) => boolean
  /** A box's click; `shift` extends the range. */
  onBox: (id: string, shift: boolean) => void
}

interface FileRowCallbacks {
  isOwn: boolean
  manualControls: boolean
  spaceId: string
  members: SpaceMember[]
  getDownloadSummary: (relPath: string) => PeerDownloadSummary | null
  getRecipients: (relPath: string, contentHash: string) => FileRecipient[]
  ownerKey: string
  getDecoration: (relPath: string) => Decoration | null
  isSeeded: (relPath: string) => boolean
  onDownload: (relPath: string, folder?: string) => void
  downloadTo?: DownloadTo
  onReveal: (relPath: string) => void
  onPause: (transferId: string) => void
  onCancel: (transferId: string) => void
  selection: TreeSelection | null
}

interface FolderTreeProps extends FileRowCallbacks {
  nodes: FileTreeNode[]
  isExpanded: (path: string) => boolean
  onToggle: (path: string) => void
}

function FolderBranch({ node, ...rest }: { node: FileTreeFolderNode } & FolderTreeProps) {
  const { t } = useTranslation()
  const groupId = useId()
  const open = rest.isExpanded(node.path)
  const { selection } = rest
  const onDevice = node.statusCounts['on-device']
  const downloading = node.statusCounts.downloading
  const preparing = node.statusCounts.preparing
  const meta = [t('folder.fileCountAndSize', { count: node.fileCount, size: formatSize(node.totalBytes) })]
  if (onDevice > 0) meta.push(t('folder.onDeviceCount', { count: onDevice }))
  if (node.folderCount > 0) meta.push(t('folder.subfolderCount', { count: node.folderCount }))
  const metaText = meta.join(' · ')
  const boxState = selection?.mode ? triState(selection.filesUnder(node.path), selection.selected) : 'off'
  // A plain click is the disclosure's; a modified click is the folder row's selection gesture.
  function onClick(e: React.MouseEvent) {
    const gesture = gestureOf(e)
    if (selection && gesture !== 'toggle' && selection.select(dirId(node.path), gesture)) return
    rest.onToggle(node.path)
  }
  return (
    <div>
      <div role="none" title={node.path} className="relative">
        {selection?.mode && (
          <SelectBox
            depth={node.depth}
            checked={boxState === 'on' ? true : boxState === 'mixed' ? 'mixed' : false}
            label={t('batch.selectFolder', { name: node.name })}
            onChange={(_next, shift) => selection.onBox(dirId(node.path), shift)}
          />
        )}
        <button
          type="button"
          aria-expanded={open}
          aria-controls={groupId}
          aria-label={node.name}
          onClick={onClick}
          className={`w-full text-left group ${boxState === 'on' ? 'bg-surface-container-highest' : 'bg-surface-container-low dark:bg-surface-container-lowest'} hover:bg-surface-container-highest dark:hover:bg-surface-container-highest rounded-xl transition-colors flex items-center gap-4 p-5 focus-ring`}
        >
          <Icon
            name="chevron_right"
            size={20}
            className={`text-on-surface-variant shrink-0 transition-transform duration-200 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
          />
          <span className="w-12 h-12 bg-surface-container-high rounded-lg flex items-center justify-center shrink-0">
            <Icon name="folder" className="text-secondary" />
          </span>
          <span className="min-w-0 flex-grow">
            <FileName name={node.path} displayName={node.name} className="font-bold text-accent" />
            <span className="text-xs text-on-surface-variant mt-0.5 block truncate">{metaText}</span>
          </span>
          {(downloading > 0 || preparing > 0) && (
            <span className="flex items-center gap-1.5 self-center mr-1 shrink-0">
              {downloading > 0 && (
                <Badge label={t('folder.downloadingCount', { count: downloading })} classes={badgeStyle('downloading').classes} />
              )}
              {preparing > 0 && (
                <Badge
                  label={t(rest.isOwn ? 'folder.addingCount' : 'folder.preparingCount', { count: preparing })}
                  classes={badgeStyle('preparing').classes}
                />
              )}
            </span>
          )}
        </button>
      </div>
      {open && (
        <div id={groupId} role="group" aria-label={node.name} className="pl-6 mt-2 space-y-2">
          <FolderTree {...rest} nodes={node.children} />
        </div>
      )}
    </div>
  )
}

export default function FolderTree(props: FolderTreeProps) {
  const { t } = useTranslation()
  const { nodes, selection, ...rest } = props
  return (
    <>
      {nodes.map((node) =>
        node.kind === 'folder' ? (
          <FolderBranch key={`folder:${node.path}`} node={node} {...props} />
        ) : (
          <FileRow
            kind="share"
            key={`file:${node.path}`}
            file={node.entry}
            decoration={rest.getDecoration(node.entry.relPath)}
            seeded={rest.isSeeded(node.entry.relPath)}
            displayName={node.name}
            isOwn={rest.isOwn}
            manualControls={rest.manualControls}
            spaceId={rest.spaceId}
            members={rest.members}
            downloadSummary={rest.isOwn ? rest.getDownloadSummary(node.entry.relPath) : null}
            recipients={rest.isOwn ? rest.getRecipients(node.entry.relPath, node.entry.hash) : NO_RECIPIENTS}
            ownerKey={rest.ownerKey}
            onDownload={rest.onDownload}
            downloadTo={rest.downloadTo}
            onReveal={rest.onReveal}
            onPause={rest.onPause}
            onCancel={rest.onCancel}
            selectKey={selection ? node.path : undefined}
            selection={selection?.mode && selection.selectable.has(node.path)
              ? { depth: node.depth, selected: selection.selected.has(node.path), label: t('space.selectNamed', { name: node.name }) }
              : null}
            onSelect={selection?.onBox}
          />
        )
      )}
    </>
  )
}
