import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../primitives/Modal.js'
import Icon from '../primitives/Icon.js'
import IconButton from '../primitives/IconButton.js'
import Button from '../primitives/Button.js'

// The edit step of a folder-mount wizard: the dialog, its header, the body its caller fills, and the
// wizard footer design.md calls footer shape 3 — Cancel plus a primary carrying a trailing arrow,
// whose label goes to "Computing…" while the scan runs.
//
// The whole body is one slot rather than a set of named field props: Add Folder puts a share-name
// field below the path, Mirror puts an owner chip above it and a read-only warning below, and a
// component that tried to name those positions would fit neither.
type MountWizardStepProps = {
  isOpen: boolean
  ariaLabel: string
  description: ReactNode
  nextLabel: string
  canProceed: boolean
  busy: boolean
  onNext: () => void
  onClose: () => void
  children: ReactNode
} & (
  | { title: string; titleNode?: never }
  | { title?: never; titleNode: ReactNode }
)

export default function MountWizardStep({
  isOpen,
  ariaLabel,
  title,
  titleNode,
  description,
  nextLabel,
  canProceed,
  busy,
  onNext,
  onClose,
  children,
}: MountWizardStepProps) {
  const { t } = useTranslation()
  const ready = canProceed && !busy
  return (
    <Modal isOpen={isOpen} onClose={onClose} onConfirm={ready ? onNext : undefined} ariaLabel={ariaLabel}>
      <div className="px-10 pt-10 pb-6">
        <div className="flex justify-between items-start mb-2 gap-3">
          {titleNode ?? (
            <h1 className="font-headline text-2xl font-extrabold text-accent tracking-tight">{title}</h1>
          )}
          <IconButton
            icon="close"
            onClick={onClose}
            ariaLabel={t('actions.close')}
            iconClassName="text-secondary"
          />
        </div>
        <p className="text-on-surface-variant font-medium">{description}</p>
      </div>

      <div className="px-10 pb-10 space-y-6">
        {children}

        <div className="pt-2 flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose}>
            {t('actions.cancel')}
          </Button>
          <Button onClick={onNext} disabled={!ready}>
            {busy ? t('scanPreview.computing') : nextLabel}
            <Icon name="arrow_forward" size={16} />
          </Button>
        </div>
      </div>
    </Modal>
  )
}
