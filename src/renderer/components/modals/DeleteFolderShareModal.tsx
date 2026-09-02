import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../primitives/Modal.js'
import IconButton from '../primitives/IconButton.js'
import Button from '../primitives/Button.js'
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
    <Modal
      isOpen={isOpen}
      onClose={busy ? () => undefined : onClose}
      ariaLabel={t('deleteFolder.title', { name: folderName })}
      panelClassName="glass-modal w-full max-w-md rounded-3xl shadow-2xl shadow-black/30 overflow-hidden relative"
    >
      <div className="px-10 pt-10 pb-6">
        <div className="flex justify-between items-start mb-2 gap-3">
          <FilenameTitle i18nKey="deleteFolder.title" name={folderName} />
          <IconButton
            icon="close"
            onClick={onClose}
            ariaLabel={t('actions.close')}
            disabled={busy}
            iconClassName="text-secondary"
          />
        </div>
      </div>

      <div className="px-10 pb-10 space-y-6">
        <p className="text-on-surface-variant font-medium">
          {t('deleteFolder.body', { space: spaceName })}
        </p>

        <div className="pt-2 flex gap-4">
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            disabled={busy}
            className="flex-1 h-14"
          >
            {t('actions.cancel')}
          </Button>
          <Button
            type="button"
            variant="danger"
            onClick={handleDelete}
            disabled={busy}
            className="flex-1 h-14"
          >
            {busy ? t('deleteFolder.deleting') : t('deleteFolder.action')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
