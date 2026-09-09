import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { fileName as getFileName } from '../../utils.js'
import Modal from '../primitives/Modal.js'
import ModalHeader from '../layout/ModalHeader.js'
import Button from '../primitives/Button.js'
import FilenameTitle from '../widgets/FilenameTitle.js'

interface RemoveFileModalProps {
  isOpen: boolean
  filePath: string
  onClose: () => void
  onRemove: () => void
}

export default function RemoveFileModal({ isOpen, filePath, onClose, onRemove }: RemoveFileModalProps) {
  const { t } = useTranslation()
  const [removing, setRemoving] = useState(false)

  async function handleRemove() {
    if (removing) return
    setRemoving(true)
    await onRemove()
    setRemoving(false)
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} isDismissable={!removing} role="alertdialog" ariaDescribedBy="remove-file-body" ariaLabel={t('removeFile.titleConfirm', { name: getFileName(filePath) })} panelClassName="glass-modal w-full max-w-md rounded-3xl shadow-2xl shadow-black/30 overflow-hidden relative">
      <>
        <ModalHeader
          titleNode={<FilenameTitle i18nKey="removeFile.titleConfirm" name={getFileName(filePath)} />}
          onClose={onClose}
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
