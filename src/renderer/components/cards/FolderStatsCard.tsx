// The folder itself, in four facts: it is a folder, this big, this many files, doing this. The
// status pill borrows the file rows' five-token palette, so "paused" is the same yellow in the tile
// and in the row beneath it. No buttons and no progress bar — the strip owns the verbs and the
// moving numbers, and it is on screen for exactly as long as there are any.
import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import Icon from '../primitives/Icon.js'
import Badge from '../primitives/Badge.js'
import { badgeStyle } from '../../statusBadge.js'
import { formatSize } from '../../utils.js'
import type { FolderStatus } from '../../folderStatus.js'

interface FolderStatsCardProps {
  totalBytes: number
  fileCount: number
  onDevice: number | null
  status: FolderStatus
}

function FolderStatsCard({ totalBytes, fileCount, onDevice, status }: FolderStatsCardProps) {
  const { t } = useTranslation()
  const meta = onDevice === null
    ? t('folder.fileCount', { count: fileCount })
    : t('folder.fileCount', { count: fileCount }) + ' · ' + t('folder.onDeviceCount', { count: onDevice })

  return (
    <div className="bg-surface-container-low rounded-2xl p-8">
      <div className="flex items-center gap-2 mb-6">
        <Icon name="folder" className="text-secondary shrink-0" />
        <h3 className="text-xl font-headline font-bold text-accent">{t('folder.folderHeading')}</h3>
        <span className="ml-auto">
          <Badge label={t(status.labelKey)} classes={badgeStyle(status.badge).classes} />
        </span>
      </div>
      <div className="text-5xl font-headline font-extrabold text-accent tracking-tighter leading-none">
        {formatSize(totalBytes)}
      </div>
      <p className="mt-2 text-sm font-medium text-on-surface-variant">{meta}</p>
    </div>
  )
}

// FolderView re-renders on every progress tick; these tiles change only when the folder does.
export default memo(FolderStatsCard)
