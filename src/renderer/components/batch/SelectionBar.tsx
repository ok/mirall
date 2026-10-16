// The selection's own strip, under the controls row: what is selected, what the selection can do,
// and Done. Neutral tone, FolderWorkStrip's anatomy. Each action button names its count; an action
// with nothing to act on is not shown. The count is announced from one polite region, not the
// rows, and that region is always mounted so the end of a selection is announced too.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Icon from '../primitives/Icon.js'
import Button from '../primitives/Button.js'
import TextButton from '../primitives/TextButton.js'
import { formatSize } from '../../format/utils.js'

export interface SelectionBarSummary {
  count: number
  bytes: number
  hidden: number
  onDevice: number
  download: number
  cancel: number
  unshare: number
}

interface SelectionBarProps {
  selecting: boolean
  summary: SelectionBarSummary
  matchingCount: number
  onDownload: () => void
  onCancel: () => void
  onUnshare?: () => void
  onDeselectHidden: () => void
  onDone: () => void
}

export default function SelectionBar({ selecting, summary, matchingCount, onDownload, onCancel, onUnshare, onDeselectHidden, onDone }: SelectionBarProps) {
  const { t } = useTranslation()
  // The end of a selection is announced once and stays until the next one starts.
  const [ended, setEnded] = useState(false)
  const [wasSelecting, setWasSelecting] = useState(selecting)
  if (wasSelecting !== selecting) {
    setWasSelecting(selecting)
    setEnded(!selecting)
  }
  const announcement = selecting ? t('batch.selectedCount', { count: summary.count }) : ended ? t('batch.ended') : ''

  return (
    <>
      {selecting && (
        // Inset by the top box and the row gap (ml-13, 52px), so the strip starts where the filter
        // field and the shifted rows start rather than under the top box.
        <div className="flex items-center gap-3 ml-13 pl-4 pr-1 py-1.5 rounded-lg text-sm bg-surface-container-low text-on-surface-variant mb-3 shrink-0">
          <Icon name="check" size={16} className="shrink-0 text-secondary" />
          <span className="flex-1 min-w-0 truncate">
            {summary.count === 0 ? (
              <>
                <span className="font-bold text-accent">{t('batch.nothingSelected')}</span>
                {' · '}
                {t('batch.nothingHint', { count: matchingCount })}
              </>
            ) : (
              <>
                <span className="font-bold text-accent">{t('batch.selectedCount', { count: summary.count })}</span>
                {' · '}
                {formatSize(summary.bytes)}
                {summary.onDevice > 0 && <>{' · '}{t('batch.onDevice', { count: summary.onDevice })}</>}
                {summary.hidden > 0 && <>{' · '}<span className="text-on-surface">{t('batch.hidden', { count: summary.hidden })}</span></>}
              </>
            )}
          </span>
          {summary.hidden > 0 && <TextButton onClick={onDeselectHidden}>{t('batch.deselectHidden')}</TextButton>}
          {summary.cancel > 0 && (
            <Button variant="secondary" onClick={onCancel} className="shrink-0">{t('batch.cancel', { count: summary.cancel })}</Button>
          )}
          {onUnshare && summary.unshare > 0 && (
            <Button variant="danger" icon="delete" onClick={onUnshare} className="shrink-0">{t('batch.unshare', { count: summary.unshare })}</Button>
          )}
          {summary.download > 0 && (
            <Button icon="download" onClick={onDownload} className="shrink-0">{t('batch.download', { count: summary.download })}</Button>
          )}
          <Button variant="secondary" onClick={onDone} className="shrink-0">{t('batch.done')}</Button>
        </div>
      )}
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
    </>
  )
}
