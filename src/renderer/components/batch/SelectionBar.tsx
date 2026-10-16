// The selection's own strip, under the controls row: what is selected, what the selection can do,
// and Done. Neutral tone, FolderWorkStrip's anatomy. Each action button names its count; an action
// with nothing to act on is not shown. Download is a split button: its main half downloads into the
// space's folder and names it, its chevron opens the Download-to menu. The count is announced from
// one polite region, not the rows, and that region is always mounted so the end of a selection is
// announced too.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Icon from '../primitives/Icon.js'
import Button from '../primitives/Button.js'
import TextButton from '../primitives/TextButton.js'
import ActionMenu from '../primitives/ActionMenu.js'
import { formatSize } from '../../format/utils.js'
import type { DownloadTo } from '../../hooks/useDownloadTo.js'

export interface SelectionBarSummary {
  count: number
  bytes: number
  hidden: number
  onDevice: number
  download: number
  unshare: number
}

interface SelectionBarProps {
  selecting: boolean
  summary: SelectionBarSummary
  matchingCount: number
  downloadTo: DownloadTo
  /** No folder: the space's. */
  onDownload: (folder?: string) => void
  onUnshare?: () => void
  onDeselectHidden: () => void
  onDone: () => void
}

interface SplitDownloadProps {
  count: number
  downloadTo: DownloadTo
  onDownload: (folder?: string) => void
}

// A folder on a drive that is not connected leaves the main half focusable but inert, so it can
// still say why; a click on it asks the worker to look again. The menu offers every other folder.
function SplitDownload({ count, downloadTo, onDownload }: SplitDownloadProps) {
  const { t } = useTranslation()
  const current = downloadTo.current
  const offline = current?.offline === true
  const label = t('batch.download', { count })
  const to = t('batch.toFolder', { folder: current?.name ?? '' })
  return (
    <div className="flex shrink-0 min-w-0" role="group" aria-label={t('batch.downloadGroup')}>
      <Button
        icon="download"
        onClick={() => (offline ? downloadTo.recheck() : onDownload())}
        ariaDisabled={offline}
        // Its name is its visible label, both parts of it, word for word.
        ariaLabel={`${label} ${to}`}
        title={current ? (offline ? t('downloadTo.offlinePath', { path: current.shown }) : current.shown) : undefined}
        splitStart
        className="pr-4 min-w-0"
      >
        {label}
        <span className="font-medium opacity-80 truncate max-w-[11rem]">{to}</span>
      </Button>
      <ActionMenu triggerVariant="split-end" label={t('batch.moreDownload')} {...downloadTo.menu(onDownload)} />
    </div>
  )
}

export default function SelectionBar({ selecting, summary, matchingCount, downloadTo, onDownload, onUnshare, onDeselectHidden, onDone }: SelectionBarProps) {
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
                {summary.download > 0 && downloadTo.current?.offline && (
                  <>{' · '}<span className="text-on-surface">{t('downloadTo.offlineStrip', { folder: downloadTo.current.name })}</span></>
                )}
              </>
            )}
          </span>
          {summary.hidden > 0 && <TextButton onClick={onDeselectHidden}>{t('batch.deselectHidden')}</TextButton>}
          {onUnshare && summary.unshare > 0 && (
            <Button variant="danger" icon="delete" onClick={onUnshare} className="shrink-0">{t('batch.unshare', { count: summary.unshare })}</Button>
          )}
          {summary.download > 0 && <SplitDownload count={summary.download} downloadTo={downloadTo} onDownload={onDownload} />}
          <Button variant="secondary" onClick={onDone} className="shrink-0">{t('batch.done')}</Button>
        </div>
      )}
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
    </>
  )
}
