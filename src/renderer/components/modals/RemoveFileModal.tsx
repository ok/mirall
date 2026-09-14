import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useErrorText } from '../../hooks/useErrorText.js'
import { fileName as getFileName } from '../../utils.js'
import { useToast } from '../toast/ToastProvider.js'
import ConfirmDestructiveModal from './ConfirmDestructiveModal.js'
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
    <ConfirmDestructiveModal
      isOpen={isOpen}
      title={t('removeFile.titleConfirm', { name: getFileName(filePath) })}
      titleNode={<FilenameTitle i18nKey="removeFile.titleConfirm" name={getFileName(filePath)} />}
      body={t('removeFile.body')}
      confirmLabel={removing ? t('removeFile.removing') : t('removeFile.action')}
      busy={removing}
      onClose={onClose}
      onConfirm={() => void handleRemove()}
    />
  )
}
