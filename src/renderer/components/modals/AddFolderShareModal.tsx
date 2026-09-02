// Two-step wizard for sharing a local folder into a space: pick and validate the
// path and share name, then confirm via the scan preview.
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../primitives/Modal.js'
import Icon from '../primitives/Icon.js'
import IconButton from '../primitives/IconButton.js'
import Button from '../primitives/Button.js'
import PathRow from '../widgets/PathRow.js'
import ScanPreviewModal from './ScanPreviewModal.js'
import { validateOwnedMount, previewOwnedMount, cancelOwnedPreview, createShareThenMount } from '../../hooks/useFolderMount.js'
import { usePreviewFlow } from '../../hooks/usePreviewFlow.js'
import type { MountValidationResult } from '../../types.js'
import { useToast } from '../toast/useToast.js'
import { mountErrorI18nKey } from '../../errorMessages.js'
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

type Step = 'edit' | 'preview'

interface FolderShareEditStepProps {
  isOpen: boolean
  spaceName: string
  mountPath: string
  shareName: string
  validationError: string | null
  nameError: string | null
  canProceed: boolean
  previewLoading: boolean
  onBrowse: () => void
  onNext: () => void
  onChangeName: (value: string) => void
  onClose: () => void
}

function FolderShareEditStep({ isOpen, spaceName, mountPath, shareName, validationError, nameError, canProceed, previewLoading, onBrowse, onNext, onChangeName, onClose }: FolderShareEditStepProps) {
  const { t } = useTranslation()
  return (
    <Modal isOpen={isOpen} onClose={onClose} ariaLabel={t('addFolder.title')}>
      <div className="px-10 pt-10 pb-6">
        <div className="flex justify-between items-start mb-2">
          <h1 className="font-headline text-2xl font-extrabold text-accent tracking-tight">{t('addFolder.title')}</h1>
          <IconButton
            icon="close"
            onClick={onClose}
            ariaLabel={t('actions.close')}
            iconClassName="text-secondary"
          />
        </div>
        <p className="text-on-surface-variant font-medium">
          {t('addFolder.description', { space: spaceName })}
        </p>
      </div>

      <div className="px-10 pb-10 space-y-6">
        <div className="space-y-3">
          <label className="font-headline text-sm font-bold text-accent px-1">{t('addFolder.pathLabel')}</label>
          <PathRow path={mountPath} onAction={onBrowse} />
          {validationError && (
            <p role="alert" className="text-xs text-error px-1">{validationError}</p>
          )}
        </div>

        <div className="space-y-3">
          <label htmlFor="add-share-name" className="font-headline text-sm font-bold text-accent px-1">{t('addFolder.nameLabel')}</label>
          <input
            id="add-share-name"
            value={shareName}
            onChange={(e) => onChangeName(e.target.value)}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? 'add-share-name-error' : undefined}
            className="w-full bg-surface-container-low border-none focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 rounded-xl px-6 py-4 text-accent font-medium placeholder:text-outline/50"
          />
          {nameError ? (
            <p id="add-share-name-error" role="alert" className="text-xs text-error px-1">{nameError}</p>
          ) : (
            <p className="text-xs text-on-surface-variant px-1">{t('addFolder.nameHelp')}</p>
          )}
        </div>

        <div className="pt-2 flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose}>
            {t('actions.cancel')}
          </Button>
          <Button onClick={onNext} disabled={!canProceed || previewLoading}>
            {previewLoading ? t('scanPreview.computing') : t('addFolder.next')}
            <Icon name="arrow_forward" size={16} />
          </Button>
        </div>
      </div>
    </Modal>
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
  const { t: tErr } = useTranslation('errors')
  const toast = useToast()
  const [mountPath, setMountPath] = useState(initialMountPath)
  const [shareName, setShareName] = useState(basename(initialMountPath))
  const [validation, setValidation] = useState<MountValidationResult | null>(null)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [step, setStep] = useState<Step>('edit')
  const { preview, progress: previewProgress, loading: previewLoading, run: runPreview, cancel: cancelPreview, reset: resetPreview } = usePreviewFlow(cancelOwnedPreview)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!isOpen) return
    setMountPath(initialMountPath)
    setShareName(basename(initialMountPath))
    setValidation(null)
    setValidationError(null)
    setStep('edit')
    resetPreview()
    return () => { cancelPreview() }
  }, [isOpen, initialMountPath])

  // Deliberately NOT on the query store, though it is param-keyed and looks like a query: this is
  // a point-in-time filesystem probe. The folder can be deleted, unmounted or filled between two
  // opens of the modal, and a cached verdict would show a stale answer for a path the user just
  // changed — a correctness regression traded for a round-trip nobody is waiting on. The cancel
  // flag stays.
  useEffect(() => {
    if (!isOpen || !mountPath) return
    let cancelled = false
    setValidation(null)
    setValidationError(null)
    validateOwnedMount(mountPath).then(
      (result) => { if (!cancelled) setValidation(result) },
      (err) => {
        if (cancelled) return
        const code = (err as { code?: string } | null)?.code
        const key = mountErrorI18nKey(code)
        setValidationError(key ? tErr(key) : err instanceof Error ? err.message : String(err))
      },
    )
    return () => { cancelled = true }
  }, [isOpen, mountPath])

  const collision = useMemo(
    () => existingShareNames.some((n) => n === shareName.trim()),
    [existingShareNames, shareName],
  )
  const nameInvalid = !isValidShareName(shareName)
  const nameError = collision ? t('addFolder.nameCollision') : nameInvalid ? t('addFolder.nameInvalid') : null

  const canProceedToPreview =
    !!validation && !validationError && !nameError && mountPath.length > 0

  async function handleBrowse() {
    const picked = await window.bridge.browseShareFolder()
    if (!picked) return
    setMountPath(picked)
    setShareName(basename(picked))
  }

  async function handleNext() {
    if (!canProceedToPreview) return
    setStep('preview')
    try {
      await runPreview((onProgress) => previewOwnedMount(spaceId, null, mountPath, { onProgress }))
    } catch (err) {
      const code = (err as { code?: string } | null)?.code
      if (code !== 'PREVIEW_CANCELLED') {
        toast.error(err instanceof Error ? err.message : String(err))
        setStep('edit')
      }
    }
  }

  function handlePreviewCancel() {
    cancelPreview()
    setStep('edit')
  }

  async function handleCreate() {
    if (submitting) return
    setSubmitting(true)
    try {
      await createShareThenMount(spaceId, shareName.trim(), mountPath)
      onCreated()
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  if (step === 'preview') {
    return (
      <ScanPreviewModal
        isOpen={isOpen}
        title={t('addFolder.title')}
        description={t('addFolder.description', { space: spaceName })}
        preview={preview}
        primaryLabel={submitting ? t('addFolder.creating') : t('addFolder.create')}
        loading={previewLoading}
        progress={previewProgress}
        onConfirm={handleCreate}
        onCancel={handlePreviewCancel}
      />
    )
  }

  return (
    <FolderShareEditStep
      isOpen={isOpen}
      spaceName={spaceName}
      mountPath={mountPath}
      shareName={shareName}
      validationError={validationError}
      nameError={nameError}
      canProceed={canProceedToPreview}
      previewLoading={previewLoading}
      onBrowse={handleBrowse}
      onNext={handleNext}
      onChangeName={setShareName}
      onClose={onClose}
    />
  )
}
