// Two-step wizard for mirroring a peer's shared folder to a local path: pick and
// validate the destination, then confirm via the scan preview.
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import Icon from '../primitives/Icon.js'
import Avatar from '../primitives/Avatar.js'
import MountPathField from '../widgets/MountPathField.js'
import FilenameTitle from '../widgets/FilenameTitle.js'
import MountWizardStep from './MountWizardStep.js'
import ScanPreviewModal from './ScanPreviewModal.js'
import { validateForeignMount, previewForeignMount, cancelForeignPreview, createForeignMount } from '../../hooks/useForeignMount.js'
import { useMountWizard } from '../../hooks/useMountWizard.js'
import type { SpaceMember } from '../../types.js'
import type { ShareWithRole } from '../../hooks/useShares.js'
import { formatSize } from '../../utils.js'
import { useQuery } from '../../store/useQuery.js'
import { Scope } from '../../../shared/contract/scope.js'

interface MirrorFolderModalProps {
  isOpen: boolean
  share: ShareWithRole
  owner: SpaceMember | null
  onClose: () => void
  onMounted: () => void
}

interface FolderInfo { fileCount: number; totalBytes: number; blobsLength: number | null }

interface OwnerLineProps {
  owner: SpaceMember | null
  ownerName: string
  folderName: string
  info: FolderInfo | undefined
  infoError: Error | null
}

function OwnerLine({ owner, ownerName, folderName, info, infoError }: OwnerLineProps) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-3 bg-surface-container rounded-xl p-3">
      <Avatar src={owner?.avatar} displayName={owner?.displayName} size="md" />
      <div className="min-w-0">
        <p className="font-bold text-accent text-sm truncate">{folderName}</p>
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
  )
}

export default function MirrorFolderModal({
  isOpen,
  share,
  owner,
  onClose,
  onMounted,
}: MirrorFolderModalProps) {
  const { t } = useTranslation()
  const ownerName = owner?.displayName ?? '?'

  // The folder's file count and byte total change when the owner's catalog does. Two scopes, the
  // same pair useShareFiles lists: share-files carries our own changes to this share, but an
  // append to a PEER's catalog — the only thing that moves these totals for a share we neither own
  // nor mirror — surfaces as event:files-updated, i.e. the space-wide files scope
  // (ensurePeerCatalogWatch).
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

  const wizard = useMountWizard({
    isOpen,
    resetKey: `${share.spaceId}/${share.owner}/${share.id}`,
    validate: (path) => validateForeignMount(path, share.id),
    startPreview: (path, onProgress) => previewForeignMount(share.spaceId, share.owner, share.id, path, { onProgress }),
    cancelPreview: cancelForeignPreview,
    commit: async (path) => { await createForeignMount(share.spaceId, share.owner, share.id, path) },
    onCommitted: () => { onMounted(); onClose() },
  })

  if (wizard.step === 'preview') {
    return (
      <ScanPreviewModal
        isOpen={isOpen}
        title={t('mirrorFolder.title', { name: share.name })}
        description={t('mirrorFolder.description', { owner: ownerName })}
        preview={wizard.preview}
        primaryLabel={wizard.submitting ? t('mirrorFolder.creating') : t('mirrorFolder.create')}
        readOnlyWarning={t('mirrorFolder.readOnlyWarning', { owner: ownerName })}
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
      ariaLabel={t('mirrorFolder.title', { name: share.name })}
      titleNode={<FilenameTitle i18nKey="mirrorFolder.title" name={share.name} />}
      description={t('mirrorFolder.description', { owner: ownerName })}
      nextLabel={t('mirrorFolder.next')}
      canProceed={wizard.pathValid}
      busy={wizard.previewLoading}
      onNext={() => { void wizard.next() }}
      onClose={onClose}
    >
      <OwnerLine
        owner={owner}
        ownerName={ownerName}
        folderName={share.name}
        info={info}
        infoError={infoError}
      />

      <MountPathField
        id="mirror-folder-path-label"
        label={t('mirrorFolder.pathLabel')}
        path={wizard.mountPath}
        error={wizard.validationError}
        onBrowse={() => { void wizard.browse() }}
      />

      <div className="bg-warning-container rounded-xl p-3.5 flex items-start gap-3">
        <Icon name="lock" size={18} className="text-on-warning-container shrink-0 mt-0.5" />
        <p className="text-xs text-on-warning-container leading-relaxed">
          {t('mirrorFolder.readOnlyWarning', { owner: ownerName })}
        </p>
      </div>
    </MountWizardStep>
  )
}
