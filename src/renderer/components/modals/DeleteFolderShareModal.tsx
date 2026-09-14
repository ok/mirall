import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import ConfirmDestructiveModal from './ConfirmDestructiveModal.js'
import FilenameTitle from '../widgets/FilenameTitle.js'

interface DeleteFolderShareModalProps {
  isOpen: boolean
  folderName: string
  spaceName: string
  onClose: () => void
  onDelete: () => void | Promise<void>
}

export default function DeleteFolderShareModal({
  isOpen,
  folderName,
  spaceName,
  onClose,
  onDelete,
}: DeleteFolderShareModalProps) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)

  async function handleDelete() {
    if (busy) return
    setBusy(true)
    try { await onDelete() }
    finally { setBusy(false) }
  }

  return (
    <ConfirmDestructiveModal
      isOpen={isOpen}
      title={t('deleteFolder.title', { name: folderName })}
      titleNode={<FilenameTitle i18nKey="deleteFolder.title" name={folderName} />}
      body={t('deleteFolder.body', { space: spaceName })}
      confirmLabel={busy ? t('deleteFolder.deleting') : t('deleteFolder.action')}
      busy={busy}
      onClose={onClose}
      onConfirm={() => void handleDelete()}
    />
  )
}
