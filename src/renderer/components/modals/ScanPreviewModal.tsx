// Shared confirmation step of the folder mount wizards: live scan progress, then
// upload/download/conflict summary cards before committing.
import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../primitives/Modal.js'
import Icon from '../primitives/Icon.js'
import IconButton from '../primitives/IconButton.js'
import Button from '../primitives/Button.js'
import ProgressBar from '../primitives/ProgressBar.js'
import FilePath from '../widgets/FilePath.js'
import { formatSize } from '../../utils.js'
import type { ScanPreview, PreviewProgress } from '../../types.js'

interface ScanPreviewModalProps {
  isOpen: boolean
  title: string
  description: string
  preview: ScanPreview | null
  primaryLabel: string
  readOnlyWarning?: string
  loading?: boolean
  progress?: PreviewProgress | null
  onConfirm: () => void | Promise<void>
  onCancel: () => void
}

export default function ScanPreviewModal({
  isOpen,
  title,
  description,
  preview,
  primaryLabel,
  readOnlyWarning,
  loading,
  progress,
  onConfirm,
  onCancel,
}: ScanPreviewModalProps) {
  const { t } = useTranslation()
  const [confirming, setConfirming] = useState(false)
  const busy = confirming || loading === true
  // A folder over the share file limit has nothing to confirm: the summary is replaced by the
  // refusal and the primary action is disabled, so the wizard cannot create it.
  const overLimit = preview?.overFileLimit === true

  async function handleConfirm() {
    if (busy || overLimit) return
    setConfirming(true)
    try { await onConfirm() }
    finally { setConfirming(false) }
  }

  return (
    <Modal isOpen={isOpen} onClose={onCancel} ariaLabel={title}>
      <div className="px-10 pt-10 pb-6">
        <div className="flex justify-between items-start mb-2">
          <h1 className="font-headline text-2xl font-extrabold text-accent tracking-tight">{title}</h1>
          <IconButton
            icon="close"
            onClick={onCancel}
            ariaLabel={t('actions.close')}
            iconClassName="text-secondary"
          />
        </div>
        <p className="text-on-surface-variant font-medium">{description}</p>
      </div>

      <div className="px-10 pb-10 space-y-4">
        <ScanPreviewBody
          preview={preview}
          loading={loading === true}
          progress={progress}
          readOnlyWarning={readOnlyWarning}
        />

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="text-accent rounded-xl px-5 py-2.5 font-headline font-bold text-sm hover:bg-surface-container active:scale-95 transition-all disabled:opacity-50"
          >
            {t('actions.cancel')}
          </button>
          <Button onClick={handleConfirm} disabled={busy || overLimit}>
            {primaryLabel}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

interface ScanPreviewBodyProps {
  preview: ScanPreview | null
  loading: boolean
  progress?: PreviewProgress | null
  readOnlyWarning?: string
}

function ScanPreviewBody({ preview, loading, progress, readOnlyWarning }: ScanPreviewBodyProps) {
  const { t } = useTranslation()

  if (loading || !preview) {
    return (
      <div className="py-8" aria-live="polite">
        <p className="text-on-surface-variant text-sm text-center mb-3">
          {progress
            ? t('scanPreview.scanning', { scanned: progress.scanned, total: progress.total, size: formatSize(progress.bytes) })
            : t('scanPreview.computing')}
        </p>
        {progress && progress.total > 0 && (
          <div className="flex justify-center">
            <ProgressBar
              value={Math.min(100, Math.round((progress.scanned / progress.total) * 100))}
              label={t('scanPreview.scanning_label')}
            />
          </div>
        )}
      </div>
    )
  }

  if (preview.overFileLimit) {
    return <OverFileLimitCard totalFiles={preview.totalFiles ?? 0} fileLimit={preview.fileLimit ?? 0} />
  }

  return (
    <>
      {preview.toUpload > 0 && (
        <SummaryCard
          tone="info"
          title={t('scanPreview.toUpload_other', { count: preview.toUpload })}
          detail={t('scanPreview.uploadDetail', { size: formatSize(preview.totalBytes) })}
        />
      )}
      {preview.toDownload > 0 && (
        <SummaryCard
          tone="info"
          title={t('scanPreview.toDownload_other', { count: preview.toDownload })}
          detail={t('scanPreview.downloadDetail', { size: formatSize(preview.totalBytes) })}
        />
      )}
      <SummaryCard
        tone={preview.conflicts > 0 ? 'warning' : 'success'}
        title={preview.conflicts > 0
          ? t('scanPreview.conflicts', { count: preview.conflicts })
          : t('scanPreview.noConflicts')}
        detail={preview.conflicts > 0
          ? t('scanPreview.conflictDetail')
          : preview.flow === 'add-owned-folder'
            ? t('scanPreview.noConflictDetailOwned')
            : t('scanPreview.noConflictDetail')}
      />

      {preview.flow !== 'add-owned-folder' && preview.conflicts === 0 && preview.existingAtDestination > 0 && (
        <SummaryCard
          tone="info"
          title={t('scanPreview.existingAtDestination', { count: preview.existingAtDestination })}
          detail={t('scanPreview.existingAtDestinationDetail')}
        />
      )}

      {readOnlyWarning && (
        <SummaryCard tone="warning" title={t('scanPreview.readOnly')} detail={readOnlyWarning} />
      )}

      {preview.perFile.length > 0 && (
        <details className="bg-surface-container-low rounded-xl px-4 py-3">
          <summary className="cursor-pointer text-xs font-bold uppercase tracking-wider text-on-surface-variant">
            {t('scanPreview.showFileList', { count: preview.perFile.length })}
          </summary>
          <div className="mt-3 max-h-40 overflow-auto pr-2 scrollbar-thin">
            {preview.perFile.map((entry) => (
              <div key={entry.relPath} className="flex justify-between items-center text-xs py-1">
                <FilePath path={entry.relPath} className="flex-1 text-on-surface mr-2" />
                <span className="text-on-surface-variant shrink-0">
                  {formatSize(entry.size)}
                  {entry.conflict ? ' · ' + t('scanPreview.conflictTag') : ''}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
    </>
  )
}

// The refusal is the outcome of the step, so it takes focus on mount: a keyboard or screen-reader
// user lands on the reason rather than on a disabled confirm button with no explanation.
function OverFileLimitCard({ totalFiles, fileLimit }: { totalFiles: number; fileLimit: number }) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => { ref.current?.focus() }, [])

  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      className="flex items-start gap-4 p-4 bg-surface-container rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
    >
      <div className="w-10 h-10 rounded-full bg-warning flex items-center justify-center shrink-0">
        <Icon name="warning" size={20} className="text-on-warning" />
      </div>
      <div className="flex-grow min-w-0">
        <p className="font-bold text-accent text-sm">
          {t('scanPreview.overFileLimit', { total: totalFiles, limit: fileLimit })}
        </p>
        <p className="text-xs text-on-surface-variant mt-0.5">{t('scanPreview.overFileLimitDetail')}</p>
      </div>
    </div>
  )
}

function SummaryCard({ tone, title, detail }: { tone: 'info' | 'success' | 'warning'; title: string; detail: string }) {
  const colors = {
    info: { bg: 'bg-info', icon: 'download' as const, iconColor: 'text-on-info' },
    success: { bg: 'bg-success', icon: 'check_circle' as const, iconColor: 'text-on-success' },
    warning: { bg: 'bg-warning', icon: 'warning' as const, iconColor: 'text-on-warning' },
  }[tone]
  return (
    <div className="flex items-center gap-4 p-4 bg-surface-container rounded-xl">
      <div className={`w-10 h-10 rounded-full ${colors.bg} flex items-center justify-center shrink-0`}>
        <Icon name={colors.icon} size={20} className={colors.iconColor} />
      </div>
      <div className="flex-grow min-w-0">
        <p className="font-bold text-accent text-sm">{title}</p>
        <p className="text-xs text-on-surface-variant mt-0.5">{detail}</p>
      </div>
    </div>
  )
}
