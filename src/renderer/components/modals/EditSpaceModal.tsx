import TextField from '../primitives/TextField.js'
import FieldLabel from '../primitives/FieldLabel.js'
import InlineError from '../primitives/InlineError.js'
import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { Space } from '../../types/types.js'
import IconPicker from '../primitives/IconPicker.js'
import PathRow from '../path/PathRow.js'
import Modal from '../primitives/Modal.js'
import Icon from '../primitives/Icon.js'
import ModalHeader from '../primitives/ModalHeader.js'
import Button from '../primitives/Button.js'
import { useErrorText } from '../../hooks/useErrorText.js'

interface EditSpaceModalProps {
  space: Space
  onSave: (spaceId: string, name: string, icon: string, downloadFolder?: string) => Promise<Space>
  onClose: () => void
}

// The download-folder block makes this the tallest modal in the app; without a cap and an
// inner scroller the Save button falls outside an overflow-hidden panel (the backdrop wrapper
// cannot scroll) once the user zooms in.
const PANEL = 'glass-modal w-full max-w-xl max-h-[85vh] rounded-3xl shadow-2xl shadow-black/30 overflow-hidden relative flex flex-col'

// Only these come from validating the folder; everything else that can reject a save (a worker
// timeout, a rename failure) must not be reported as a folder problem.
const FOLDER_ERROR_CODES = new Set(['DOWNLOAD_FOLDER_INVALID', 'DOWNLOAD_FOLDER_OVERLAPS_MOUNT'])

export default function EditSpaceModal({ space, onSave, onClose }: EditSpaceModalProps) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const [name, setName] = useState(space.name)
  const [icon, setIcon] = useState(space.icon)
  const [saving, setSaving] = useState(false)
  // The folder picked here, until Save; undefined while the space's own stands.
  const [folderEdit, setFolderEdit] = useState<string | undefined>(undefined)
  // Two errors, two homes: a screen reader must not be told the name field is at fault for a
  // folder the app could not use, so each is associated with the control it belongs to.
  const [nameError, setNameError] = useState<string | null>(null)
  const [folderError, setFolderError] = useState<string | null>(null)

  const folder = folderEdit ?? space.downloadFolder
  const hasChanges = name.trim() !== space.name || icon !== space.icon || folderEdit !== undefined
  const isValid = name.trim().length >= 2

  const handleBrowse = useCallback(async () => {
    setFolderError(null)
    const picked = await window.bridge.browseDownloadFolder(folder)
    if (picked) setFolderEdit(picked)
  }, [folder])

  function handleTyped(typed: string) {
    setFolderError(null)
    setFolderEdit(typed)
  }

  async function handleSave() {
    if (!isValid || !hasChanges || saving) return
    setSaving(true)
    setNameError(null)
    setFolderError(null)
    try {
      await onSave(space.spaceId, name.trim(), icon, folderEdit)
      onClose()
    } catch (err) {
      const code = (err as { code?: string } | null)?.code
      const detail = errorText(err)
      if (code && FOLDER_ERROR_CODES.has(code)) setFolderError(t('editSpace.folderError', { error: detail }))
      else setNameError(t('editSpace.saveError', { error: detail }))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal isOpen onClose={onClose} onConfirm={handleSave} ariaLabel={t('editSpace.title')} panelClassName={PANEL}>
      <>
        <ModalHeader
          title={t('editSpace.title')}
          description={t('editSpace.desc')}
          onClose={onClose}
          className="shrink-0"
        />

        <div className="px-10 pb-10 space-y-8 overflow-y-auto">
          <div className="space-y-3">
            <TextField
              id="edit-space-name"
              label={t('createSpace.nameLabel')}
              autoFocus
              error={nameError}
              placeholder={t('createSpace.namePlaceholder')}
              value={name}
              onChange={setName}
            />
          </div>

          <div className="space-y-3">
            <FieldLabel>{t('createSpace.iconLabel')}</FieldLabel>
            <IconPicker selected={icon} onSelect={setIcon} />
          </div>

          <div className="space-y-3">
            <FieldLabel htmlFor="edit-space-folder">{t('editSpace.downloadFolder')}</FieldLabel>
            <p id="edit-space-folder-desc" className="text-sm text-on-surface-variant px-1">
              {t('editSpace.downloadFolderDesc')}
            </p>
            <PathRow
              id="edit-space-folder"
              path={folder}
              onAction={handleBrowse}
              onCommit={handleTyped}
              ariaDescribedBy={`edit-space-folder-desc${folderError ? ' edit-space-folder-error' : ''}`}
            />
            {folderError && (
              <InlineError id="edit-space-folder-error" className="px-1">{folderError}</InlineError>
            )}
          </div>

          <div className="pt-4">
            <Button size="lg" fullWidth onClick={handleSave} disabled={!isValid || !hasChanges || saving}>
              {saving ? t('actions.saving') : t('actions.save')}
              <Icon name="check" />
            </Button>
          </div>
        </div>
      </>
    </Modal>
  )
}
