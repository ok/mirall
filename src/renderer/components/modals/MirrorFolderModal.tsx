// Two-step wizard for mirroring a peer's shared folder to a local path: pick and
// validate the destination, then confirm via the scan preview.
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../primitives/Modal.js'
import Icon from '../primitives/Icon.js'
import IconButton from '../primitives/IconButton.js'
import Button from '../primitives/Button.js'
import Avatar from '../primitives/Avatar.js'
import PathRow from '../widgets/PathRow.js'
import FilenameTitle from '../widgets/FilenameTitle.js'
import ScanPreviewModal from './ScanPreviewModal.js'
import { validateForeignMount, previewForeignMount, cancelForeignPreview, createForeignMount } from '../../hooks/useForeignMount.js'
import { usePreviewFlow } from '../../hooks/usePreviewFlow.js'
import type { MountValidationResult, SpaceMember } from '../../types.js'
import type { ShareWithRole } from '../../hooks/useShares.js'
import { formatSize } from '../../utils.js'
import { useToast } from '../toast/useToast.js'
import { useQuery } from '../../store/useQuery.js'
import { Scope } from '../../scope.js'
import { useErrorText } from '../../hooks/useErrorText.js'

interface MirrorFolderModalProps {
  isOpen: boolean
  share: ShareWithRole
  owner: SpaceMember | null
  onClose: () => void
  onMounted: () => void
}

interface FolderInfo { fileCount: number; totalBytes: number; blobsLength: number | null }

function OwnerChip({ owner }: { owner: SpaceMember | null }) {
  return <Avatar src={owner?.avatar} displayName={owner?.displayName} size="md" />
}

type Step = 'edit' | 'preview'

export default function MirrorFolderModal({
  isOpen,
  share,
  owner,
  onClose,
  onMounted,
}: MirrorFolderModalProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const errorText = useErrorText()
  const [mountPath, setMountPath] = useState('')
  const [validation, setValidation] = useState<MountValidationResult | null>(null)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [step, setStep] = useState<Step>('edit')
  const [submitting, setSubmitting] = useState(false)
  const { preview, progress: previewProgress, loading: previewLoading, run: runPreview, cancel: cancelPreview, reset: resetPreview } = usePreviewFlow(cancelForeignPreview)
  const ownerName = owner?.displayName ?? '?'

  // The folder's file count and byte total change when the owner's catalog does. Two scopes, the
  // same pair useShareFiles lists: share-files carries our own changes to this share, but an
  // append to a PEER's catalog — the only thing that moves these totals for a share we neither own
  // nor mirror — surfaces as event:files-updated, i.e. the space-wide files scope
  // (ensurePeerCatalogWatch). Pinning share-files alone left the cached totals frozen for the
  // whole app session, where the pre-cache per-open fetch had refreshed them.
  const infoScopes = useMemo(
    () => [Scope.shareFiles(share.spaceId, share.id), Scope.files(share.spaceId)],
    [share.spaceId, share.id],
  )
  const { data: info, error: infoError } = useQuery<FolderInfo>(
    'share:folder-info',
    { spaceId: share.spaceId, ownerKey: share.owner, shareId: share.id },
    infoScopes,
    { enabled: isOpen },
  )

  // Form state only: it is genuinely per-open, unlike the folder info above.
  useEffect(() => {
    if (!isOpen) return
    setMountPath('')
    setValidation(null)
    setValidationError(null)
    setStep('edit')
    resetPreview()
    return () => { cancelPreview() }
  }, [isOpen, share.id, share.owner, share.spaceId])

  // Deliberately NOT on the query store — the twin of AddFolderShareModal's owned-mount probe.
  // This is a point-in-time filesystem check of a path the user is still editing: a cached verdict
  // would answer for a path they have since changed. The cancel flag stays.
  useEffect(() => {
    if (!isOpen || !mountPath) return
    let cancelled = false
    setValidation(null)
    setValidationError(null)
    validateForeignMount(mountPath, share.id).then(
      (result) => { if (!cancelled) setValidation(result) },
      (err) => {
        if (cancelled) return
        setValidationError(errorText(err))
      },
    )
    return () => { cancelled = true }
  }, [isOpen, mountPath, share.id, errorText])

  const canProceed = !!validation && !validationError && mountPath.length > 0

  async function handleBrowse() {
    const picked = await window.bridge.browseShareFolder()
    if (picked) setMountPath(picked)
  }

  async function handleNext() {
    if (!canProceed) return
    setStep('preview')
    try {
      await runPreview((onProgress) => previewForeignMount(share.spaceId, share.owner, share.id, mountPath, { onProgress }))
    } catch (err) {
      const code = (err as { code?: string } | null)?.code
      if (code !== 'PREVIEW_CANCELLED') {
        toast.error(errorText(err))
        setStep('edit')
      }
    }
  }

  function handlePreviewCancel() {
    cancelPreview()
    setStep('edit')
  }

  async function handleConfirm() {
    if (submitting) return
    setSubmitting(true)
    try {
      await createForeignMount(share.spaceId, share.owner, share.id, mountPath)
      onMounted()
      onClose()
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setSubmitting(false)
    }
  }

  if (step === 'preview') {
    return (
      <ScanPreviewModal
        isOpen={isOpen}
        title={t('mirrorFolder.title', { name: share.name })}
        description={t('mirrorFolder.description', { owner: ownerName })}
        preview={preview}
        primaryLabel={submitting ? t('mirrorFolder.creating') : t('mirrorFolder.create')}
        readOnlyWarning={t('mirrorFolder.readOnlyWarning', { owner: ownerName })}
        loading={previewLoading}
        progress={previewProgress}
        onConfirm={handleConfirm}
        onCancel={handlePreviewCancel}
      />
    )
  }

  return (
    <MirrorEditStep
      isOpen={isOpen}
      share={share}
      owner={owner}
      ownerName={ownerName}
      info={info}
      infoError={infoError}
      mountPath={mountPath}
      validationError={validationError}
      canProceed={canProceed}
      previewLoading={previewLoading}
      onBrowse={handleBrowse}
      onNext={handleNext}
      onClose={onClose}
    />
  )
}

interface MirrorEditStepProps {
  isOpen: boolean
  share: ShareWithRole
  owner: SpaceMember | null
  ownerName: string
  info: FolderInfo | undefined
  infoError: Error | null
  mountPath: string
  validationError: string | null
  canProceed: boolean
  previewLoading: boolean
  onBrowse: () => void
  onNext: () => void
  onClose: () => void
}

function MirrorEditStep({ isOpen, share, owner, ownerName, info, infoError, mountPath, validationError, canProceed, previewLoading, onBrowse, onNext, onClose }: MirrorEditStepProps) {
  const { t } = useTranslation()
  return (
    <Modal isOpen={isOpen} onClose={onClose} ariaLabel={t('mirrorFolder.title', { name: share.name })}>
      <div className="px-10 pt-10 pb-6">
        <div className="flex justify-between items-start mb-2 gap-3">
          <FilenameTitle i18nKey="mirrorFolder.title" name={share.name} />
          <IconButton
            icon="close"
            onClick={onClose}
            ariaLabel={t('actions.close')}
            iconClassName="text-secondary"
          />
        </div>
        <p className="text-on-surface-variant font-medium">
          {t('mirrorFolder.description', { owner: ownerName })}
        </p>
      </div>

      <div className="px-10 pb-10 space-y-6">
        <div className="flex items-center gap-3 bg-surface-container rounded-xl p-3">
          <OwnerChip owner={owner} />
          <div className="min-w-0">
            <p className="font-bold text-accent text-sm truncate">{share.name}</p>
            {/* A failed read is said, not filled in: rendering the fallback totals would put a
                fabricated measurement of the folder in front of the person about to mirror it. */}
            {infoError ? (
              <p role="alert" className="text-xs text-error">{t('mirrorFolder.infoUnavailable')}</p>
            ) : (
              <p className="text-xs text-on-surface-variant">
                {t('mirrorFolder.ownerLine', {
                  count: info?.fileCount ?? 0,
                  size: info ? formatSize(info.totalBytes) : '—',
                  owner: ownerName,
                })}
              </p>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <span id="mirror-folder-path-label" className="block font-headline text-sm font-bold text-accent px-1">
            {t('mirrorFolder.pathLabel')}
          </span>
          <PathRow path={mountPath} onAction={onBrowse} ariaDescribedBy="mirror-folder-path-label" />
          {validationError && (
            <p role="alert" className="text-xs text-error px-1">{validationError}</p>
          )}
        </div>

        <div className="bg-warning-container rounded-xl p-3.5 flex items-start gap-3">
          <Icon name="lock" size={18} className="text-on-warning-container shrink-0 mt-0.5" />
          <p className="text-xs text-on-warning-container leading-relaxed">
            {t('mirrorFolder.readOnlyWarning', { owner: ownerName })}
          </p>
        </div>

        <div className="pt-2 flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose}>
            {t('actions.cancel')}
          </Button>
          <Button onClick={onNext} disabled={!canProceed || previewLoading}>
            {previewLoading ? t('scanPreview.computing') : t('mirrorFolder.next')}
            <Icon name="arrow_forward" size={16} />
          </Button>
        </div>
      </div>
    </Modal>
  )
}
