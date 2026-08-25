import { useTranslation } from 'react-i18next'
import Modal from '../primitives/Modal.js'
import Button from '../primitives/Button.js'
import IconButton from '../primitives/IconButton.js'
import { formatSize } from '../../formatSize.js'

interface Props {
  isOpen: boolean
  text: string
  byteLength: number
  redacted: boolean
  onSave: () => void
  onClose: () => void
}

export default function DiagnosticsPreviewModal({ isOpen, text, byteLength, redacted, onSave, onClose }: Props) {
  const { t } = useTranslation()
  return (
    <Modal isOpen={isOpen} onClose={onClose} ariaLabel={t('diagnostics.previewTitle')}>
      <div className="px-10 pt-10 pb-4">
        <div className="flex justify-between items-start mb-2">
          <h1 className="font-headline text-2xl font-extrabold text-accent tracking-tight">
            {t('diagnostics.previewTitle')}
          </h1>
          <IconButton
            icon="close"
            onClick={onClose}
            ariaLabel={t('actions.close')}
            iconClassName="text-secondary"
          />
        </div>
        <p className="text-on-surface-variant font-medium">
          {redacted ? t('diagnostics.previewIntro') : t('diagnostics.previewIntroRaw')}
        </p>
      </div>

      <div className="px-10 pb-4">
        <pre
          tabIndex={0}
          role="region"
          aria-label={t('diagnostics.previewRegion')}
          className="max-h-80 overflow-y-auto scrollbar-thin rounded-xl bg-surface-container-lowest p-5 text-xs font-mono whitespace-pre-wrap break-all text-on-surface-variant focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
        >
          {text}
        </pre>
      </div>

      <div className="px-10 pb-10 flex items-center gap-3">
        <Button onClick={onSave}>{t('diagnostics.saveFile')}</Button>
        <Button variant="secondary" onClick={onClose}>{t('actions.close')}</Button>
        <span className="ml-auto text-xs text-on-surface-variant">
          {t('diagnostics.approxSize', { size: formatSize(byteLength) })}
        </span>
      </div>
    </Modal>
  )
}
