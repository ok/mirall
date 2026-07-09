import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Space } from '../../types.js'
import IconPicker from '../widgets/IconPicker.js'
import Modal from '../primitives/Modal.js'
import Icon from '../primitives/Icon.js'
import IconButton from '../primitives/IconButton.js'
import Button from '../primitives/Button.js'

interface EditSpaceModalProps {
  space: Space
  onSave: (spaceId: string, name: string, icon: string) => Promise<Space>
  onClose: () => void
}

export default function EditSpaceModal({ space, onSave, onClose }: EditSpaceModalProps) {
  const { t } = useTranslation()
  const [name, setName] = useState(space.name)
  const [icon, setIcon] = useState(space.icon)
  const [saving, setSaving] = useState(false)

  const hasChanges = name.trim() !== space.name || icon !== space.icon
  const isValid = name.trim().length >= 2

  async function handleSave() {
    if (!isValid || !hasChanges || saving) return
    setSaving(true)
    try {
      await onSave(space.spaceId, name.trim(), icon)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal isOpen onClose={onClose} onConfirm={handleSave} ariaLabel={t('editSpace.title')}>
      <>
        <div className="px-10 pt-10 pb-6">
          <div className="flex justify-between items-start mb-2">
            <h1 className="font-headline text-2xl font-extrabold text-accent tracking-tight">
              {t('editSpace.title')}
            </h1>
            <IconButton
              icon="close"
              onClick={onClose}
              ariaLabel={t('actions.close')}
              iconClassName="text-secondary"
            />
          </div>
          <p className="text-on-surface-variant font-medium">
            {t('editSpace.desc')}
          </p>
        </div>

        <div className="px-10 pb-10 space-y-8">
          <div className="space-y-3">
            <label htmlFor="edit-space-name" className="font-headline text-sm font-bold text-accent px-1">{t('createSpace.nameLabel')}</label>
            <input
              id="edit-space-name"
              autoFocus
              className="w-full bg-surface-container-low border-none focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 rounded-xl px-6 py-4 text-accent font-medium placeholder:text-outline/50 transition-all"
              placeholder={t('createSpace.namePlaceholder')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSave()}
            />
          </div>

          <div className="space-y-3">
            <label className="font-headline text-sm font-bold text-accent px-1">{t('createSpace.iconLabel')}</label>
            <IconPicker selected={icon} onSelect={setIcon} />
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
