// Two-step wizard for sharing a local folder into a space: pick and validate the
// path and share name, then confirm via the scan preview.
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import MountPathField from '../widgets/MountPathField.js'
import MountWizardStep from './MountWizardStep.js'
import ScanPreviewModal from './ScanPreviewModal.js'
import { validateOwnedMount, previewOwnedMount, cancelOwnedPreview, createShareThenMount } from '../../hooks/useFolderMount.js'
import { useMountWizard } from '../../hooks/useMountWizard.js'
import { basename, isValidShareName } from '../../sharePaths.js'

interface AddFolderShareModalProps {
  isOpen: boolean
  spaceId: string
  spaceName: string
  existingShareNames: string[]
  initialMountPath: string
  onClose: () => void
  onCreated: () => void
}

interface ShareNameFieldProps {
  value: string
  error: string | null
  onChange: (value: string) => void
}

function ShareNameField({ value, error, onChange }: ShareNameFieldProps) {
  const { t } = useTranslation()
  return (
    <div className="space-y-3">
      <label htmlFor="add-share-name" className="font-headline text-sm font-bold text-accent px-1">{t('addFolder.nameLabel')}</label>
      <input
        id="add-share-name"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? 'add-share-name-error' : undefined}
        className="w-full bg-surface-container-low border-none focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 rounded-xl px-6 py-4 text-accent font-medium placeholder:text-outline/50"
      />
      {error ? (
        <p id="add-share-name-error" role="alert" className="text-xs text-error px-1">{error}</p>
      ) : (
        <p className="text-xs text-on-surface-variant px-1">{t('addFolder.nameHelp')}</p>
      )}
    </div>
  )
}

export default function AddFolderShareModal({
  isOpen,
  spaceId,
  spaceName,
  existingShareNames,
  initialMountPath,
  onClose,
  onCreated,
}: AddFolderShareModalProps) {
  const { t } = useTranslation()
  const [shareName, setShareName] = useState(basename(initialMountPath))

  const wizard = useMountWizard({
    isOpen,
    initialPath: initialMountPath,
    validate: validateOwnedMount,
    startPreview: (path, onProgress) => previewOwnedMount(spaceId, null, path, { onProgress }),
    cancelPreview: cancelOwnedPreview,
    commit: async (path) => { await createShareThenMount(spaceId, shareName.trim(), path) },
    onCommitted: () => { onCreated(); onClose() },
  })

  // The name is the wizard's only field it does not own, so it re-seeds on the same edge the wizard
  // resets on: a fresh open, or a different folder dropped in.
  useEffect(() => {
    if (isOpen) setShareName(basename(initialMountPath))
  }, [isOpen, initialMountPath])

  const collision = useMemo(
    () => existingShareNames.some((n) => n === shareName.trim()),
    [existingShareNames, shareName],
  )
  const nameInvalid = !isValidShareName(shareName)
  const nameError = collision ? t('addFolder.nameCollision') : nameInvalid ? t('addFolder.nameInvalid') : null

  async function handleBrowse() {
    const picked = await wizard.browse()
    if (picked) setShareName(basename(picked))
  }

  if (wizard.step === 'preview') {
    return (
      <ScanPreviewModal
        isOpen={isOpen}
        title={t('addFolder.title')}
        description={t('addFolder.description', { space: spaceName })}
        preview={wizard.preview}
        primaryLabel={wizard.submitting ? t('addFolder.creating') : t('addFolder.create')}
        loading={wizard.previewLoading}
        progress={wizard.progress}
        onConfirm={wizard.confirm}
        onCancel={wizard.backToEdit}
      />
    )
  }

  return (
    <MountWizardStep
      isOpen={isOpen}
      ariaLabel={t('addFolder.title')}
      title={t('addFolder.title')}
      description={t('addFolder.description', { space: spaceName })}
      nextLabel={t('addFolder.next')}
      canProceed={wizard.pathValid && !nameError}
      busy={wizard.previewLoading}
      onNext={() => { void wizard.next() }}
      onClose={onClose}
    >
      <MountPathField
        id="add-folder-path-label"
        label={t('addFolder.pathLabel')}
        path={wizard.mountPath}
        error={wizard.validationError}
        onBrowse={() => { void handleBrowse() }}
      />

      <ShareNameField value={shareName} error={nameError} onChange={setShareName} />
    </MountWizardStep>
  )
}
