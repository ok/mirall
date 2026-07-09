// Recursive renderer for the collapsible FolderView tree: folders are disclosure
// buttons (aria-expanded + aria-controls) over native ShareFileRow leaves.
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import Icon from '../primitives/Icon.js'
import Badge from '../primitives/Badge.js'
import ShareFileRow from '../cards/ShareFileRow.js'
import { formatSize } from '../../utils.js'
import type { FileTreeNode, FileTreeFolderNode, SpaceMember, PeerDownloadSummary } from '../../types.js'

interface FileRowCallbacks {
  isOwn: boolean
  manualControls: boolean
  spaceId: string
  members: SpaceMember[]
  getDownloadSummary: (relPath: string) => PeerDownloadSummary | null
  onDownload: (relPath: string) => void
  onReveal: (relPath: string) => void
  onPause: (transferId: string) => void
  onCancel: (transferId: string) => void
  onDiscardPartial: (relPath: string) => void
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
  const onDevice = node.statusCounts['on-device']
  const downloading = node.statusCounts.downloading
  const meta = [t('folder.fileCountAndSize', { count: node.fileCount, size: formatSize(node.totalBytes) })]
  if (onDevice > 0) meta.push(t('folder.onDeviceCount', { count: onDevice }))
  if (node.folderCount > 0) meta.push(t('folder.subfolderCount', { count: node.folderCount }))
  const metaText = meta.join(' · ')
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={groupId}
        aria-label={node.name}
        onClick={() => rest.onToggle(node.path)}
        className="w-full text-left group bg-surface-container-low dark:bg-surface-container-lowest hover:bg-surface-container-highest dark:hover:bg-surface-container-highest rounded-xl transition-colors flex items-center gap-4 p-5 focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
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
          <span className="font-bold text-accent block truncate">{node.name}</span>
          <span className="text-xs text-on-surface-variant mt-0.5 block truncate">{metaText}</span>
        </span>
        {downloading > 0 && (
          <Badge label={t('folder.downloadingCount', { count: downloading })} classes="bg-info text-accent" className="self-center mr-1" />
        )}
      </button>
      {open && (
        <div id={groupId} role="group" aria-label={node.name} className="pl-6 mt-2 space-y-2">
          <FolderTree {...rest} nodes={node.children} />
        </div>
      )}
    </div>
  )
}

export default function FolderTree(props: FolderTreeProps) {
  const { nodes, ...rest } = props
  return (
    <>
      {nodes.map((node) =>
        node.kind === 'folder' ? (
          <FolderBranch key={`folder:${node.path}`} node={node} {...props} />
        ) : (
          <ShareFileRow
            key={`file:${node.path}`}
            file={node.entry}
            displayName={node.name}
            leadingGutter
            isOwn={rest.isOwn}
            manualControls={rest.manualControls}
            spaceId={rest.spaceId}
            members={rest.members}
            downloadSummary={rest.isOwn ? rest.getDownloadSummary(node.entry.relPath) : null}
            onDownload={rest.onDownload}
            onReveal={rest.onReveal}
            onPause={rest.onPause}
            onCancel={rest.onCancel}
            onDiscardPartial={rest.onDiscardPartial}
          />
        )
      )}
    </>
  )
}
