// Space screen: loose files and folder shares with drag-drop adding, transfer controls, member presence, and invites.
//
// One `dialog` at a time — see SpaceDialog. `busy` holds the public keys with an approve or deny
// in flight.
//
// Actions raised from outside the screen — mirror a folder from the folder screen, or a title-bar
// command fired while the folder screen was open — arrive as `pendingAction` and are consumed once
// this screen can act on them.
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useFiles } from '../hooks/useFiles.js'
import { useDecorations } from '../hooks/useDecorations.js'
import { useTransferControls } from '../hooks/useTransferControls.js'
import { usePeerDownloads } from '../hooks/usePeerDownloads.js'
import { useMembers } from '../hooks/useMembers.js'
import { useSpaces } from '../hooks/useSpaces.js'
import { useShares, type ShareWithRole } from '../hooks/useShares.js'
import { useProfile } from '../hooks/useProfile.js'
import { useDragShare } from '../hooks/useDragShare.js'
import SpaceDialogs, { type SpaceDialog } from '../components/modals/SpaceDialogs.js'
import JoinRequestCard from '../components/cards/JoinRequestCard.js'
import HiddenFileInput from '../components/primitives/HiddenFileInput.js'
import { useToast } from '../components/toast/ToastProvider.js'
import SpaceHeaderBar from '../components/layout/SpaceHeaderBar.js'
import SpaceAlert from '../components/space/SpaceAlert.js'
import SpaceContentPane from '../components/space/SpaceContentPane.js'
import PendingSpaceHero from '../components/space/PendingSpaceHero.js'
import type { PendingSpaceAction } from '../shell/space-actions.js'
import { useRunAction } from '../hooks/useRunAction.js'
import { useMembershipRequests } from '../hooks/useMembershipRequests.js'
import { useSpaceCardActions } from '../hooks/useSpaceCardActions.js'
import { usePendingSpaceAction } from '../hooks/usePendingSpaceAction.js'
import { useLocateShare } from '../hooks/useLocateShare.js'

interface SpaceViewProps {
  spaceId: string
  // An action raised before this screen existed, waiting to be acted on.
  pendingAction: PendingSpaceAction | null
  onActionConsumed: () => void
  onBack: () => void
  onManageStorage: () => void
  onOpenShare?: (share: ShareWithRole) => void
}

export default function SpaceScreen({ spaceId, pendingAction, onActionConsumed, onBack, onManageStorage, onOpenShare }: SpaceViewProps) {
  const { t } = useTranslation()
  const { profile } = useProfile()
  const {
    files, loading, error, refresh, isSeeded, addFiles, downloadFile,
    unshareFile, cancelPublish, revealFile,
  } = useFiles(spaceId)
  const { getDecoration } = useDecorations('transfer', spaceId, '/')
  const { cancelDownload, pauseDownload } = useTransferControls()
  const { getDownloadSummary } = usePeerDownloads(spaceId)
  const { members, requests } = useMembers(spaceId)
  const { spaces, createInvite, leaveSpace, updateSpace, toggleFavorite, approveMember, denyMember } = useSpaces()
  const space = spaces.find(s => s.spaceId === spaceId)
  const isPending = space?.status === 'pending'
  // Created before v1.7.0, when every space became encrypted. No upgrade path exists, and the
  // data layer now assumes v2 throughout — so say so rather than let it half-work.
  const isLegacy = !!space && space.schemaVersion !== 2
  const { shares, loading: sharesLoading } = useShares(spaceId, profile?.personKey ?? null)
  const toast = useToast()
  const { locate } = useLocateShare(spaceId)
  const [dialog, setDialog] = useState<SpaceDialog | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { dragKind, fileCount, folderName, dragActive, dragHandlers } = useDragShare({
    onFiles: addFiles,
    onFolder: handleShareFolderRequest,
    folderEnabled: true,
    onFolderUnsupported: () => toast.info(t('dropZone.folderComingSoon')),
  })

  function handleShareFolderRequest(droppedPath: string) {
    if (droppedPath && droppedPath.length > 0) {
      setDialog({ kind: 'add-folder', path: droppedPath })
      return
    }
    openFolderPicker()
  }

  // Both list sources feed one pane; see spaceContentState.js for why emptiness needs both.
  const pane = { filesLoading: loading, sharesLoading, filesError: error, fileCount: files.length, shareCount: shares.length }

  const { busy, approve: handleApprove, deny: handleDeny, approveMany: handleApproveMany } = useMembershipRequests({ spaceId, requests, approveMember, denyMember })
  const runAction = useRunAction()
  const closeDialog = useCallback(() => setDialog(null), [])

  const cardActions = useSpaceCardActions({
    spaceId, openDialog: setDialog, revealFile, cancelPublish, onOpenShare,
  })
  const { openFolderPicker } = usePendingSpaceAction({
    spaceId, pendingAction, onActionConsumed, shares, sharesLoading, isPending, isLegacy,
    openDialog: setDialog,
    onAddFiles: useCallback(() => fileInputRef.current?.click(), []),
  })

  function handleInvite() {
    if (isPending || isLegacy) return
    setDialog({ kind: 'invite' })
  }

  function handleCancelRequest() {
    runAction(async () => {
      await leaveSpace(spaceId)
      onBack()
    })
  }

  async function handleLeave() {
    await leaveSpace(spaceId)
  }

  async function handleUnshareFile() {
    if (dialog?.kind !== 'remove-file') return
    await unshareFile(dialog.file.path)
    closeDialog()
  }

  return (
    <div className="max-w-7xl mx-auto px-8 flex flex-col h-[calc(100vh-5rem-var(--banner-h,0px))]">
      <HiddenFileInput ref={fileInputRef} onFiles={addFiles} />
      <SpaceHeaderBar
        spaceName={space?.name || t('space.fallbackName')}
        isPending={isPending}
        isLegacy={isLegacy}
        favorite={!!space?.favorite}
        onBack={onBack}
        onCancelRequest={handleCancelRequest}
        onInvite={handleInvite}
        onToggleFavorite={() => runAction(() => toggleFavorite(spaceId))}
        onEdit={() => setDialog({ kind: 'edit' })}
        onManageStorage={onManageStorage}
        onLeave={() => setDialog({ kind: 'leave' })}
      />

      {isLegacy && <SpaceAlert text={t('space.legacyWarning')} />}
      {space?.creatorDivergence && <SpaceAlert text={t('space.creatorDivergenceWarning')} />}

      {space?.status !== 'pending' && requests.length > 0 && (
        <div className="shrink-0 pb-4">
          <JoinRequestCard
            requests={requests}
            busyKeys={busy}
            onApprove={handleApprove}
            onDeny={handleDeny}
            onReview={() => setDialog({ kind: 'approval' })}
          />
        </div>
      )}

      {space?.status === 'pending' ? (
        <PendingSpaceHero
          spaceName={space?.name || t('space.fallbackName')}
          inviters={members.filter((m) => m.publicKey !== profile?.personKey)}
        />
      ) : (
        <SpaceContentPane
          spaceId={spaceId}
          members={members}
          isLegacy={isLegacy}
          pane={pane}
          onFilesSelected={addFiles}
          onShareFolderRequest={handleShareFolderRequest}
          drag={{ handlers: dragHandlers, active: dragActive, kind: dragKind, fileCount, folderName }}
          shares={shares}
          selfProfile={profile}
          onLocate={locate}
          cardActions={cardActions}
          listing={{
            files,
            error,
            onRetry: () => { void refresh() },
            getDecoration,
            isSeeded,
            getDownloadSummary,
            onDownload: downloadFile,
            onCancel: cancelDownload,
            onPause: pauseDownload,
          }}
        />
      )}

      <SpaceDialogs
        dialog={dialog}
        onClose={closeDialog}
        space={space}
        spaceId={spaceId}
        spaceName={space?.name || t('space.fallbackName')}
        requests={requests}
        busyKeys={busy}
        members={members}
        existingShareNames={shares.filter((s) => s.role === 'mine').map((s) => s.name)}
        onApproveMany={(keys) => void handleApproveMany(keys)}
        onDeny={handleDeny}
        onCreateInvite={(opts) => createInvite(spaceId, opts)}
        onSaveSpace={updateSpace}
        onLeave={handleLeave}
        onLeft={onBack}
        onRemoveFile={handleUnshareFile}
      />
    </div>
  )
}
