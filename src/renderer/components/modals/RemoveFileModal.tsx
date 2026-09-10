import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useErrorText } from '../../hooks/useErrorText.js'
import { fileName as getFileName } from '../../utils.js'
import { useToast } from '../toast/ToastProvider.js'
import Modal from '../primitives/Modal.js'
import ModalHeader from '../layout/ModalHeader.js'
import Button from '../primitives/Button.js'
import FilenameTitle from '../widgets/FilenameTitle.js'

interface RemoveFileModalProps {
  isOpen: boolean
  filePath: string
  onClose: () => void
  onRemove: () => void | Promise<void>
}

export default function RemoveFileModal({ isOpen, filePath, onClose, onRemove }: RemoveFileModalProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const errorText = useErrorText()
  const [removing, setRemoving] = useState(false)

  // A rejected removal reports and leaves the dialog on its confirm step: the busy flag is what
  // makes the dialog undismissable, so clearing it is the only thing that gives the escape routes
  // (Escape, the backdrop, the close button) back.
  async function handleRemove() {
    if (removing) return
    setRemoving(true)
    try { await onRemove() }
    catch (err) { toast.error(errorText(err)) }
    finally { setRemoving(false) }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} isDismissable={!removing} role="alertdialog" ariaDescribedBy="remove-file-body" ariaLabel={t('removeFile.titleConfirm', { name: getFileName(filePath) })} panelClassName="glass-modal w-full max-w-md rounded-3xl shadow-2xl shadow-black/30 overflow-hidden relative">
      <>
        <ModalHeader
          titleNode={<FilenameTitle i18nKey="removeFile.titleConfirm" name={getFileName(filePath)} />}
          onClose={onClose}
          closeDisabled={removing}
        />

        <div className="px-10 pb-10 space-y-6">
          <p id="remove-file-body" className="text-on-surface-variant font-medium">
            {t('removeFile.body')}
          </p>

          <div className="pt-2 flex gap-4">
            <Button
              variant="secondary"
              autoFocus
              onClick={onClose}
              disabled={removing}
              className="flex-1 h-14"
            >
              {t('actions.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={handleRemove}
              disabled={removing}
              className="flex-1 h-14"
            >
              {removing ? t('removeFile.removing') : t('removeFile.action')}
            </Button>
          </div>
        </div>
      </>
    </Modal>
  )
}
