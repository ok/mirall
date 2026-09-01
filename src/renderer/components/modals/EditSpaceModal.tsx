import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { Space } from '../../types.js'
import { mountErrorI18nKey } from '../../errorMessages.js'
import IconPicker from '../widgets/IconPicker.js'
import FilePath from '../widgets/FilePath.js'
import Modal from '../primitives/Modal.js'
import Icon from '../primitives/Icon.js'
import IconButton from '../primitives/IconButton.js'
import Button from '../primitives/Button.js'

interface EditSpaceModalProps {
  space: Space
  onSave: (spaceId: string, name: string, icon: string, downloadFolder?: string | null) => Promise<Space>
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
  const { t: tErr } = useTranslation('errors')
  const [name, setName] = useState(space.name)
  const [icon, setIcon] = useState(space.icon)
  const [saving, setSaving] = useState(false)
  // undefined = untouched, null = reset to the global default, string = new override.
  const [folderEdit, setFolderEdit] = useState<string | null | undefined>(undefined)
  const [globalDefault, setGlobalDefault] = useState('')
  const [error, setError] = useState<string | null>(null)
  const browseRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let cancelled = false
    window.bridge.getDownloadFolder()
      .then((folder) => { if (!cancelled) setGlobalDefault(folder) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const effectiveFolder = folderEdit === undefined
    ? (space.downloadFolder ?? globalDefault)
    : (folderEdit ?? globalDefault)
  const isOverridden = folderEdit === undefined ? !!space.downloadFolder : folderEdit !== null

  const hasChanges = name.trim() !== space.name || icon !== space.icon || folderEdit !== undefined
  const isValid = name.trim().length >= 2

  const handleBrowse = useCallback(async () => {
    setError(null)
    const picked = await window.bridge.browseDownloadFolder(effectiveFolder || undefined)
    if (picked) setFolderEdit(picked)
  }, [effectiveFolder])

  // Clicking this unmounts it, which would drop keyboard focus to the document. Hand focus
  // back to the control the user is most likely to want next, and let the status paragraph
  // below (a live region) announce what changed.
  const handleUseDefault = useCallback(() => {
    setError(null)
    setFolderEdit(null)
    browseRef.current?.focus()
  }, [])

  async function handleSave() {
    if (!isValid || !hasChanges || saving) return
    setSaving(true)
    setError(null)
    try {
      await onSave(space.spaceId, name.trim(), icon, folderEdit)
      onClose()
    } catch (err) {
      const code = (err as { code?: string } | null)?.code
      const key = mountErrorI18nKey(code)
      const detail = key ? tErr(key) : err instanceof Error ? err.message : String(err)
      setError(code && FOLDER_ERROR_CODES.has(code)
        ? t('editSpace.folderError', { error: detail })
        : t('editSpace.saveError', { error: detail }))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal isOpen onClose={onClose} onConfirm={handleSave} ariaLabel={t('editSpace.title')} panelClassName={PANEL}>
      <>
        <div className="px-10 pt-10 pb-6 shrink-0">
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

        <div className="px-10 pb-10 space-y-8 overflow-y-auto">
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

          <div className="space-y-3">
            <span id="edit-space-folder-label" className="block font-headline text-sm font-bold text-accent px-1">
              {t('editSpace.downloadFolder')}
            </span>
            <p id="edit-space-folder-desc" className="text-sm text-on-surface-variant px-1">
              {t('editSpace.downloadFolderDesc')}
            </p>
            <div className="flex items-center gap-3">
              <FilePath path={effectiveFolder} className="flex-1 text-sm text-accent" />
              <Button
                ref={browseRef}
                variant="secondary"
                onClick={handleBrowse}
                ariaDescribedBy="edit-space-folder-label edit-space-folder-desc"
                className="shrink-0"
              >
                {t('storageSettings.changeFolder')}
              </Button>
            </div>
            <div className="flex items-center min-h-5">
              {isOverridden && (
                <button
                  type="button"
                  onClick={handleUseDefault}
                  className="text-xs text-secondary underline px-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 rounded"
                >
                  {t('editSpace.useDefault')}
                </button>
              )}
              {/* Always mounted, so switching back to the default is announced — a live region
                  added at the same moment as its text is not read out. */}
              <p role="status" aria-live="polite" className="text-xs text-on-surface-variant px-1">
                {isOverridden ? '' : t('editSpace.usingDefault')}
              </p>
            </div>
          </div>

          {error && (
            <p className="text-sm text-error" role="alert">{error}</p>
          )}

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
