// Two-step wizard for sharing a local folder into a space: pick and validate the
// path and share name, then confirm via the scan preview.
import TextField from '../primitives/TextField.js'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import MountPathField from '../path/MountPathField.js'
import MountWizardStep from './MountWizardStep.js'
import ScanPreviewModal from './ScanPreviewModal.js'
import { validateOwnedMount, previewOwnedMount, cancelOwnedPreview, createShareThenMount } from '../../hooks/useFolderMount.js'
import { useMountWizard } from '../../hooks/useMountWizard.js'
import { basename, isValidShareName } from '../../model/sharePaths.js'

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
    <TextField
      id="add-share-name"
      label={t('addFolder.nameLabel')}
      value={value}
      onChange={onChange}
      error={error}
      help={t('addFolder.nameHelp')}
    />
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
