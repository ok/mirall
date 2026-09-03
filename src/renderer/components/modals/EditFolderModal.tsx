// Rename a folder and move it on disk. The two edits are independent on purpose: the name lives on
// the owner's share record and replicates, the path lives in the local mount, and a failure in one
// must not silently roll back the other — so each reports its own error and each is skipped when
// untouched.
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../primitives/Modal.js'
import Icon from '../primitives/Icon.js'
import IconButton from '../primitives/IconButton.js'
import Button from '../primitives/Button.js'
import PathRow from '../widgets/PathRow.js'
import { useErrorText } from '../../hooks/useErrorText.js'

interface EditFolderModalProps {
  isOwner: boolean
  // An owner's source folder is only re-pointable while it is actually missing. Re-pointing a
  // healthy one runs a deep reconcile that retires every catalog key with no file behind it at the
  // new path — a wrong pick would empty the folder for every member — and that needs a preview,
  // which this modal does not have. The path stays visible either way.
  canRelocate: boolean
  name: string
  ownerName: string
  mountPath: string | null
  onRename: (name: string) => Promise<void>
  onRelocate: (mountPath: string) => Promise<void>
  onClose: () => void
}

const PANEL = 'glass-modal w-full max-w-xl max-h-[85vh] rounded-3xl shadow-2xl shadow-black/30 overflow-hidden relative flex flex-col'

export default function EditFolderModal({
  isOwner,
  canRelocate,
  name,
  ownerName,
  mountPath,
  onRename,
  onRelocate,
  onClose,
}: EditFolderModalProps) {
  const { t } = useTranslation()
  const reasonFor = useErrorText()
  const [draftName, setDraftName] = useState(name)
  const [draftPath, setDraftPath] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // setSaving lands a render later, so the flag it guards is stale for anything that can fire twice
  // in one dispatch — which the name field's Enter and the modal's Cmd+Enter both can.
  const savingRef = useRef(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [pathError, setPathError] = useState<string | null>(null)

  const effectivePath = draftPath ?? mountPath
  const trimmed = draftName.trim()
  const nameChanged = isOwner && trimmed !== name
  const pathChanged = draftPath !== null && draftPath !== mountPath
  // Deliberately only "not empty": isValidShareName lives in the worker's contract and a second,
  // divergent copy here would either block a name the worker accepts or promise one it rejects.
  const nameValid = !isOwner || trimmed.length > 0
  const canSave = nameValid && (nameChanged || pathChanged) && !saving

  async function handleBrowse() {
    setPathError(null)
    const picked = await window.bridge.browseShareFolder()
    if (picked) setDraftPath(picked)
  }

  async function handleSave() {
    if (!canSave || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setNameError(null)
    setPathError(null)
    let failed = false
    if (nameChanged) {
      try {
        await onRename(trimmed)
      } catch (err) {
        setNameError(t('editFolder.nameError', { error: reasonFor(err) }))
        failed = true
      }
    }
    if (pathChanged && draftPath) {
      try {
        await onRelocate(draftPath)
      } catch (err) {
        setPathError(t('editFolder.locationError', { error: reasonFor(err) }))
        failed = true
      }
    }
    savingRef.current = false
    setSaving(false)
    if (!failed) onClose()
  }

  return (
    <Modal isOpen onClose={onClose} onConfirm={handleSave} ariaLabel={t('editFolder.title')} panelClassName={PANEL}>
      <>
        <div className="px-10 pt-10 pb-6 shrink-0">
          <div className="flex justify-between items-start mb-2">
            <h1 className="font-headline text-2xl font-extrabold text-accent tracking-tight">{t('editFolder.title')}</h1>
            <IconButton icon="close" onClick={onClose} ariaLabel={t('actions.close')} iconClassName="text-secondary" />
          </div>
          <p className="text-on-surface-variant font-medium">
            {isOwner ? t('editFolder.descOwner') : t('editFolder.descMirror')}
          </p>
        </div>

        <div className="px-10 pb-10 space-y-8 overflow-y-auto">
          <div className="space-y-3">
            <label htmlFor="edit-folder-name" className="font-headline text-sm font-bold text-accent px-1">
              {t('editFolder.nameLabel')}
            </label>
            <input
              id="edit-folder-name"
              autoFocus={isOwner}
              disabled={!isOwner}
              aria-describedby={isOwner ? undefined : 'edit-folder-name-note'}
              className="w-full bg-surface-container-low border-none focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 rounded-xl px-6 py-4 text-accent font-medium placeholder:text-outline/50 transition-all disabled:opacity-60"
              placeholder={t('editFolder.namePlaceholder')}
              value={isOwner ? draftName : name}
              onChange={(e) => setDraftName(e.target.value)}
              /* Cmd/Ctrl+Enter is the modal's own confirm gesture and bubbles to it; handling the
                 modified Enter here too would run the save twice in one dispatch. */
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) handleSave() }}
            />
            {!isOwner && (
              <p id="edit-folder-name-note" className="text-sm text-on-surface-variant px-1">
                {t('editFolder.nameOwnedBy', { owner: ownerName })}
              </p>
            )}
            {nameError && <p className="text-sm text-error px-1" role="alert">{nameError}</p>}
          </div>

          <div className="space-y-3">
            <span id="edit-folder-path-label" className="block font-headline text-sm font-bold text-accent px-1">
              {isOwner ? t('editFolder.sourceLabel') : t('editFolder.mirrorLabel')}
            </span>
            <p id="edit-folder-path-desc" className="text-sm text-on-surface-variant px-1">
              {!canRelocate ? t('editFolder.sourceFixed') : isOwner ? t('editFolder.sourceDesc') : t('editFolder.mirrorDesc')}
            </p>
            {/* Same row as Add Folder and Mirror to Disk — a path is a path, whichever door you
                came through. Display-only when the location is fixed: the field stays, the button
                is what says whether you can re-point it. */}
            <PathRow
              path={effectivePath}
              onAction={canRelocate ? handleBrowse : undefined}
              ariaDescribedBy="edit-folder-path-label edit-folder-path-desc"
            />
            {pathError && <p className="text-sm text-error px-1" role="alert">{pathError}</p>}
          </div>

          <div className="pt-4">
            <Button size="lg" fullWidth onClick={handleSave} disabled={!canSave}>
              {saving ? t('actions.saving') : t('actions.save')}
              <Icon name="check" />
            </Button>
          </div>
        </div>
      </>
    </Modal>
  )
}
