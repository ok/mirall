// One strip for the downloads under way in a listing, in the info tone of the folder's working strip. Not a
// live region: its counts change about twice a second, so the start and end are announced by the
// screen from a count-free sentence instead.
import { useTranslation } from 'react-i18next'
import Icon from '../primitives/Icon.js'
import Button from '../primitives/Button.js'
import DownloadProgressLane from '../primitives/DownloadProgressLane.js'
import { formatSize } from '../../format/utils.js'
import type { BatchProgress } from '../../model/batch-progress.js'

interface BatchProgressStripProps {
  progress: BatchProgress
  onCancelAll: () => void
}

export default function BatchProgressStrip({ progress, onCancelAll }: BatchProgressStripProps) {
  const { t } = useTranslation()
  // Every file paused (an owner offline, a download stopped by hand): the strip says so rather than
  // claiming a download, and Cancel All still reaches them.
  const parts = [t(progress.moving ? 'batch.progress' : 'batch.progressPaused', { count: progress.files })]
  if (progress.done > 0) parts.push(t('batch.progressDone', { count: progress.done }))
  parts.push(t('batch.progressLeft', { size: formatSize(progress.bytesLeft) }))
  return (
    <div className="flex items-center gap-3 px-4 py-2 rounded-lg text-sm bg-info-container text-on-info-container">
      <Icon name="download" size={16} className={`shrink-0${progress.moving ? ' animate-pulse' : ''}`} />
      <span className="flex-1 min-w-0 truncate">{parts.join(' · ')}</span>
      <span className="basis-40 shrink-0">
        <DownloadProgressLane value={progress.pct} label={t('batch.progressLabel')} showPct host="info-container" />
      </span>
      <Button variant="secondary" onClick={onCancelAll}>{t('batch.cancelAll')}</Button>
    </div>
  )
}
