// Space screen: loose files and folder shares with drag-drop adding, transfer controls, member presence, and invites.
//
// One `dialog` at a time — see SpaceDialog. `busy` holds the public keys with an approve or deny
// in flight.
//
// Actions raised from outside the screen — mirror a folder from the folder screen, or a title-bar
// command fired while the folder screen was open — arrive as `pendingAction` and are consumed once
// this screen can act on them.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FileEntry, JoinRequest, Space, SpaceMember } from '../types.js'
import { useFiles } from '../hooks/useFiles.js'
import { useDecorations } from '../hooks/useDecorations.js'
import { useTransferControls } from '../hooks/useTransferControls.js'
import { usePeerDownloads } from '../hooks/usePeerDownloads.js'
import { useMembers } from '../hooks/useMembers.js'
import { useSpaces } from '../hooks/useSpaces.js'
import { useShares, type ShareWithRole } from '../hooks/useShares.js'
import { useProfile } from '../hooks/useProfile.js'
import { useHasVerticalOverflow } from '../hooks/useHasVerticalOverflow.js'
import { useDragShare } from '../hooks/useDragShare.js'
import DropZone from '../components/widgets/DropZone.js'
import DropOverlay from '../components/widgets/DropOverlay.js'
import FileCard from '../components/cards/FileCard.js'
import ShareCard from '../components/cards/ShareCard.js'
import MembersBox from '../components/widgets/MembersBox.js'
import LoadingFiles from '../components/widgets/LoadingFiles.js'
import JoinRequestBanner from '../components/widgets/JoinRequestBanner.js'
import ApprovalModal from '../components/modals/ApprovalModal.js'
import StorageIndicator from '../components/widgets/StorageIndicator.js'
import LeaveSpaceModal from '../components/modals/LeaveSpaceModal.js'
import RemoveFileModal from '../components/modals/RemoveFileModal.js'
import AddFolderShareModal from '../components/modals/AddFolderShareModal.js'
import DeleteFolderShareModal from '../components/modals/DeleteFolderShareModal.js'
import MirrorFolderModal from '../components/modals/MirrorFolderModal.js'
import { setForeignMountEnabled, unmountForeignMount } from '../hooks/useForeignMount.js'
import { useToast } from '../components/toast/ToastProvider.js'
import { request } from '../ipc.js'
import ActionMenu from '../components/widgets/ActionMenu.js'
import InviteModal from '../components/modals/InviteModal.js'
import EditSpaceModal from '../components/modals/EditSpaceModal.js'
import Icon from '../components/primitives/Icon.js'
import Button from '../components/primitives/Button.js'
import EntityHeader from '../components/layout/EntityHeader.js'
import AvatarStack from '../components/primitives/AvatarStack.js'
import DocsCard from '../components/widgets/DocsCard.js'
import type { PendingSpaceAction } from '../space-actions.js'
import { showSpaceEmptyState, showSpaceLoading } from '../spaceContentState.js'
import { useErrorText } from '../hooks/useErrorText.js'
import { useRunAction } from '../hooks/useRunAction.js'
import { useLocateShare } from '../hooks/useLocateShare.js'

interface SpaceHeaderActionsProps {
  isPending: boolean
  isLegacy: boolean
  favorite: boolean
  onCancelRequest: () => void
  onInvite: () => void
  onToggleFavorite: () => void
  onEdit: () => void
  onManageStorage: () => void
  onLeave: () => void
}

function SpaceHeaderActions({
  isPending,
  isLegacy,
  favorite,
  onCancelRequest,
  onInvite,
  onToggleFavorite,
  onEdit,
  onManageStorage,
  onLeave,
}: SpaceHeaderActionsProps) {
  const { t } = useTranslation()
  // Not a member yet — expose nothing member-only (invite/edit/storage), just a way to withdraw
  // the request.
  if (isPending) {
    return (
      <Button variant="secondary" icon="close" onClick={onCancelRequest}>
        {t('space.cancelRequest')}
      </Button>
    )
  }
  return (
    <>
      <Button icon="group_add" onClick={onInvite} disabled={isLegacy}>
        {t('space.inviteShort')}
      </Button>
      <ActionMenu
        label={t('space.more')}
        items={[
          {
            id: 'favorite',
            label: favorite ? t('space.removeFavorite') : t('space.addFavorite'),
            icon: 'star',
            iconFilled: favorite,
            onAction: onToggleFavorite,
          },
          {
            id: 'edit',
            label: t('space.edit'),
            icon: 'edit',
            disabled: isLegacy,
            onAction: onEdit,
          },
          {
            id: 'manage-storage',
            label: t('space.manageStorage'),
            icon: 'database',
            onAction: onManageStorage,
          },
          {
            id: 'leave',
            label: t('space.leave'),
            icon: 'logout',
            variant: 'danger',
            onAction: onLeave,
          },
        ]}
      />
    </>
  )
}

// The dialogs this screen can show, one at a time by construction. They were eight independent
// pieces of state and nothing held them apart: an action arriving from another screen could raise a
// second dialog behind the one already up. Each carries exactly what it needs to open.
type SpaceDialog =
  | { kind: 'invite' }
  | { kind: 'approval' }
  | { kind: 'leave' }
  | { kind: 'edit' }
  | { kind: 'remove-file'; file: FileEntry }
  | { kind: 'add-folder'; path: string }
  | { kind: 'delete-share'; share: ShareWithRole }
  | { kind: 'mirror-share'; share: ShareWithRole }

interface SpaceViewProps {
  spaceId: string
  // An action raised before this screen existed, waiting to be acted on.
  pendingAction: PendingSpaceAction | null
  onActionConsumed: () => void
  onBack: () => void
  onManageStorage: () => void
  onOpenShare?: (share: ShareWithRole) => void
}

// Every dialog the space screen can show, in one place: which one is on screen is the `dialog`
// union's job, and this reads it. It lives apart from the screen because the screen's own body is
// about the content behind them.
function SpaceDialogs({
  dialog, onClose, space, spaceId, spaceName, requests, busyKeys, members, existingShareNames,
  onApproveMany, onDeny, onCreateInvite, onSaveSpace, onLeave, onLeft, onRemoveFile,
}: {
  dialog: SpaceDialog | null
  onClose: () => void
  space: Space | undefined
  spaceId: string
  spaceName: string
  requests: JoinRequest[]
  busyKeys: Set<string>
  members: SpaceMember[]
  existingShareNames: string[]
  onApproveMany: (keys: string[]) => void
  onDeny: (publicKey: string) => void
  onCreateInvite: (opts: { autoApprove: boolean; expiresInMs: number }) => Promise<string>
  onSaveSpace: (spaceId: string, name: string, icon: string, downloadFolder?: string | null) => Promise<Space>
  onLeave: () => Promise<void>
  onLeft: () => void
  onRemoveFile: () => Promise<void>
}) {
  return (
    <>
      <ApprovalModal
        isOpen={dialog?.kind === 'approval'}
        requests={requests}
        busyKeys={busyKeys}
        onApproveMany={onApproveMany}
        onDeny={onDeny}
        onClose={onClose}
      />
      <InviteModal
        isOpen={dialog?.kind === 'invite'}
        onCreate={onCreateInvite}
        onClose={onClose}
      />
      <LeaveSpaceModal
        isOpen={dialog?.kind === 'leave'}
        spaceName={spaceName}
        spaceId={spaceId}
        onClose={onClose}
        onLeave={onLeave}
        onComplete={onLeft}
      />
      {space && dialog?.kind === 'edit' && (
        <EditSpaceModal
          space={space}
          onSave={onSaveSpace}
          onClose={onClose}
        />
      )}
      <RemoveFileModal
        isOpen={dialog?.kind === 'remove-file'}
        filePath={dialog?.kind === 'remove-file' ? dialog.file.path : ''}
        onClose={onClose}
        onRemove={onRemoveFile}
      />
      <AddFolderShareModal
        isOpen={dialog?.kind === 'add-folder'}
        spaceId={spaceId}
        spaceName={spaceName}
        existingShareNames={existingShareNames}
        initialMountPath={dialog?.kind === 'add-folder' ? dialog.path : ''}
        onClose={onClose}
        onCreated={onClose}
      />
      <DeleteFolderShareModal
        isOpen={dialog?.kind === 'delete-share'}
        folderName={dialog?.kind === 'delete-share' ? dialog.share.name : ''}
        spaceName={spaceName}
        onClose={onClose}
        onDelete={async () => {
          if (dialog?.kind !== 'delete-share') return
          await request('owned-folder:delete', { spaceId, shareId: dialog.share.id })
          onClose()
        }}
      />
      {dialog?.kind === 'mirror-share' && (
        <MirrorFolderModal
          isOpen
          share={dialog.share}
          owner={members.find((m) => m.publicKey === dialog.share.owner) ?? null}
          onClose={onClose}
          onMounted={onClose}
        />
      )}
    </>
  )
}

export default function SpaceView({ spaceId, pendingAction, onActionConsumed, onBack, onManageStorage, onOpenShare }: SpaceViewProps) {
  const { t } = useTranslation()
  const { profile } = useProfile()
  const {
    files,
    loading,
    error,
    refresh,
    isSeeded,
    addFiles,
    downloadFile,
    unshareFile,
    discardPartial,
    cancelPublish,
    revealFile,
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
  const { shares, loading: sharesLoading } = useShares(spaceId, profile?.publicKey ?? null)
  const toast = useToast()
  const errorText = useErrorText()
  const { locate } = useLocateShare(spaceId)
  const [dialog, setDialog] = useState<SpaceDialog | null>(null)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const { ref: filesRef, hasOverflow: filesOverflow } = useHasVerticalOverflow<HTMLDivElement>()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { dragKind, fileCount, folderName, dragActive, dragHandlers } = useDragShare({
    onFiles: addFiles,
    onFolder: handleShareFolderRequest,
    folderEnabled: true,
    onFolderUnsupported: () => toast.info(t('dropZone.folderComingSoon')),
  })

  async function handleShareFolderRequest(droppedPath: string) {
    if (droppedPath && droppedPath.length > 0) {
      setDialog({ kind: 'add-folder', path: droppedPath })
      return
    }
    const picked = await window.bridge.browseShareFolder()
    if (picked) setDialog({ kind: 'add-folder', path: picked })
  }

  // Both list sources feed one pane; see spaceContentState.js for why emptiness needs both.
  const pane = {
    filesLoading: loading,
    sharesLoading,
    filesError: error,
    fileCount: files.length,
    shareCount: shares.length,
  }

  const runAction = useRunAction()
  const closeDialog = useCallback(() => setDialog(null), [])

  const markBusy = (pk: string) => setBusy((prev) => new Set(prev).add(pk))
  const clearBusy = (pk: string) => setBusy((prev) => {
    if (!prev.has(pk)) return prev
    const next = new Set(prev)
    next.delete(pk)
    return next
  })

  async function handleApprove(pk: string) {
    if (busy.has(pk)) return
    markBusy(pk)
    try {
      await approveMember(spaceId, pk)
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      clearBusy(pk)
    }
  }

  // Approving a batch runs one at a time on purpose: each approval writes membership and re-reads
  // the roster, and firing them together lets the last write land on a roster the earlier ones had
  // already grown. Every failure is counted rather than raised, so a batch reports once instead of
  // stacking a toast per request behind a closed dialog.
  async function handleApproveMany(keys: string[]) {
    const pending = keys.filter((pk) => !busy.has(pk))
    if (pending.length === 0) return
    pending.forEach(markBusy)
    let done = 0
    for (const pk of pending) {
      try {
        await approveMember(spaceId, pk)
        done++
      } catch {
        // Counted in the summary below.
      } finally {
        clearBusy(pk)
      }
    }
    if (done < pending.length) {
      toast.error(t('space.approvePartial', { done, total: pending.length, failed: pending.length - done }))
    }
  }

  async function handleDeny(pk: string) {
    if (busy.has(pk)) return
    markBusy(pk)
    try {
      await denyMember(spaceId, pk)
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      clearBusy(pk)
    }
  }

  // The row handlers below are useCallback'd because they are props of memoized rows (ShareCard,
  // FileCard): an identity that changes every render defeats the memo, and the decoration
  // heartbeat re-renders this screen once a second for as long as a transfer is live. `locate` comes
  // out of useLocateShare already wrapped, for the same reason.
  const handleOpenShare = useCallback((share: ShareWithRole) => { onOpenShare?.(share) }, [onOpenShare])

  const handleOpenInFinder = useCallback((share: ShareWithRole) => {
    runAction(() => request('share:reveal-folder', { spaceId, ownerKey: share.owner, shareId: share.id }))
  }, [spaceId, runAction])

  const handleDeleteRequest = useCallback((share: ShareWithRole) => { setDialog({ kind: 'delete-share', share }) }, [])
  const handleMirrorRequest = useCallback((share: ShareWithRole) => { setDialog({ kind: 'mirror-share', share }) }, [])

  const handleUnmount = useCallback((share: ShareWithRole) => {
    runAction(() => unmountForeignMount(share.spaceId, share.id))
  }, [runAction])

  const handlePauseMirror = useCallback((share: ShareWithRole) => {
    runAction(() => setForeignMountEnabled(share.spaceId, share.id, false))
  }, [runAction])

  const handleResumeMirror = useCallback((share: ShareWithRole) => {
    runAction(() => setForeignMountEnabled(share.spaceId, share.id, true))
  }, [runAction])

  useEffect(() => {
    let live = true
    if (!pendingAction) return
    if (pendingAction.kind === 'mirror') {
      const share = shares.find((s) => s.id === pendingAction.shareId)
      // The listing is the authority on the folder. While it is still loading a miss means "not
      // here yet", so the action waits; once it has loaded, a miss means the folder is gone and
      // the action is dropped rather than held forever.
      if (!share) {
        if (!sharesLoading) onActionConsumed()
        return
      }
      setDialog({ kind: 'mirror-share', share })
      onActionConsumed()
      return
    }
    const { action } = pendingAction
    // Leave is the only action a legacy space keeps: everything else writes, and the data layer
    // refuses it (SPACE_UNSUPPORTED) because there is no content key and no way to mint one.
    if (action === 'leave') setDialog({ kind: 'leave' })
    else if (isPending || isLegacy) { /* refused below the UI; drop it rather than hold it */ }
    else if (action === 'add-files') fileInputRef.current?.click()
    else if (action === 'add-folder') {
      // The folder picker is modal to the user, not to the app: they can leave this space while it
      // is open, and a folder chosen after that belongs to a screen that is gone.
      void window.bridge.browseShareFolder().then((picked) => { if (live && picked) setDialog({ kind: 'add-folder', path: picked }) })
    }
    else if (action === 'invite') setDialog({ kind: 'invite' })
    else if (action === 'edit') setDialog({ kind: 'edit' })
    onActionConsumed()
    return () => { live = false }
  }, [pendingAction, shares, sharesLoading, isPending, isLegacy, onActionConsumed])

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

  const handleReveal = useCallback((file: FileEntry) => {
    runAction(() => revealFile(file.path))
  }, [revealFile, runAction])

  const handleRemoveRequest = useCallback((file: FileEntry) => { setDialog({ kind: 'remove-file', file }) }, [])

  const handleCancelPublish = useCallback((file: FileEntry) => {
    runAction(() => cancelPublish(file.path))
  }, [cancelPublish, runAction])

  return (
    <div className="max-w-7xl mx-auto px-8 flex flex-col h-[calc(100vh-5rem-var(--banner-h,0px))]">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const list = Array.from(e.target.files ?? [])
          if (list.length > 0) addFiles(list)
          e.target.value = ''
        }}
      />
      <EntityHeader
        name={space?.name || t('space.fallbackName')}
        onBack={onBack}
        titleAdornment={isLegacy ? (
          <span className="shrink-0 inline-flex items-center px-2.5 py-1 rounded-full bg-error-container text-on-error-container text-xs font-bold border border-outline">
            {t('space.legacyBadge')}
          </span>
        ) : null}
        actions={
          <SpaceHeaderActions
            isPending={isPending}
            isLegacy={isLegacy}
            favorite={!!space?.favorite}
            onCancelRequest={handleCancelRequest}
            onInvite={handleInvite}
            onToggleFavorite={() => runAction(() => toggleFavorite(spaceId))}
            onEdit={() => setDialog({ kind: 'edit' })}
            onManageStorage={onManageStorage}
            onLeave={() => setDialog({ kind: 'leave' })}
          />
        }
      />

      {isLegacy && (
        <div className="shrink-0 pb-4">
          <div role="alert" className="rounded-2xl p-4 flex items-center gap-3 bg-error-container">
            <Icon name="warning" className="text-on-error-container shrink-0" />
            <p className="flex-1 min-w-0 font-bold text-on-error-container">{t('space.legacyWarning')}</p>
          </div>
        </div>
      )}

      {space?.creatorDivergence && (
        <div className="shrink-0 pb-4">
          <div role="alert" className="rounded-2xl p-4 flex items-center gap-3 bg-error-container">
            <Icon name="warning" className="text-on-error-container shrink-0" />
            <p className="flex-1 min-w-0 font-bold text-on-error-container">{t('space.creatorDivergenceWarning')}</p>
          </div>
        </div>
      )}

      {space?.status !== 'pending' && requests.length > 0 && (
        <div className="shrink-0 pb-4">
          <JoinRequestBanner
            requests={requests}
            busyKeys={busy}
            onApprove={handleApprove}
            onDeny={handleDeny}
            onReview={() => setDialog({ kind: 'approval' })}
          />
        </div>
      )}

      {space?.status === 'pending' ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center pb-8">
          {(() => {
            const inviters = members.filter((m) => m.publicKey !== profile?.publicKey)
            return inviters.length > 0 ? (
              <AvatarStack
                className="mb-5"
                size="xl"
                surface="surface-container-lowest"
                announce="each"
                overflow={0}
                avatars={inviters.slice(0, 3).map((m) => ({
                  key: m.publicKey,
                  src: m.avatar,
                  displayName: m.displayName,
                }))}
              />
            ) : null
          })()}
          {/* The live region covers only the two strings that change; the card below is
              static and would be re-announced on every render from inside it. */}
          <div role="status" aria-live="polite" className="flex flex-col items-center">
            <h2 className="text-2xl font-headline font-bold text-accent mb-3">
              {t('space.waitingApproval', { name: space?.name || t('space.fallbackName') })}
            </h2>
            <p className="text-on-surface-variant max-w-md leading-relaxed">{t('space.waitingApprovalHint')}</p>
          </div>
          <DocsCard
            icon="lock"
            title={t('space.waitingDocsTitle')}
            body={t('space.waitingDocsBody')}
            className="w-full max-w-lg mt-8"
            links={[
              { target: { page: 'explanation', anchor: 'membership-approval' }, label: t('docs.membershipApproval') },
              { target: { page: 'guides', anchor: 'fix-a-stuck-join' }, label: t('docs.stuckJoin') },
            ]}
          />
        </div>
      ) : (
        <div
        /* No `overflow-hidden`: ShareCard's click target is an `absolute inset-0` overlay whose
           `focus-visible:ring-2` paints outside the card, and the cards sit flush against this box.
           `min-h-0` is what constrains the height; the drop overlay is inset from this same
           positioned ancestor, so its bounds are unchanged. */
          className="relative flex-1 min-h-0 grid grid-cols-1 min-[900px]:grid-cols-[1fr_300px] gap-8 pt-4 pb-8"
          {...(isLegacy ? {} : dragHandlers)}
        >
          <div
            ref={filesRef}
            /* SCROLL-PANE RULES (the one statement; FolderView and ActivityLog point here).
             `relative`: `sr-only` spans are `position: absolute` and clip only from their containing
             block, so an unpositioned pane lets rows below the fold grow the DOCUMENT into an OS
             scrollbar. `-mx-1 pl-1 pr-1`: 4px of ring room for a focused card, cancelled by the
             negative margin so nothing moves; `pr-4` is the shared scrollbar gutter. No `pt-*` under
             a `sticky top-0` header: it pins at the scrollport top PLUS the pane's padding-top. */
            className={`relative overflow-y-auto scrollbar-thin min-h-0 -mx-1 pl-1 pb-4 space-y-8${filesOverflow ? ' pr-4' : ' pr-1'}`}
          >
            {showSpaceEmptyState(pane) ? (
              <div className="flex flex-col min-h-[24rem] mt-12">
                <div className="h-[10.5rem] flex items-center justify-end gap-5 pr-12">
                  <Icon name="draft" size={45} className="text-secondary" />
                  <Icon name="folder" filled size={45} className="text-secondary" />
                  <svg
                    viewBox="0 0 512 256"
                    className="w-[6.5rem] h-[3.25rem] text-secondary ml-1"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="28"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="60,80 140,128 60,176" opacity="0.35" />
                    <polyline points="200,80 280,128 200,176" opacity="0.65" />
                    <polyline points="340,80 420,128 340,176" opacity="1" />
                  </svg>
                </div>
                <div className="flex-1 flex flex-col items-center justify-center text-center px-10 pb-10">
                  <h2 className="text-2xl font-headline font-bold text-accent mb-3">
                    {t('space.emptyShareTitle')}
                  </h2>
                  <p className="text-on-surface-variant max-w-md leading-relaxed">
                    {t('space.emptyShareSubtitle')}
                  </p>
                  <DocsCard
                    icon="menu_book"
                    title={t('space.emptyShareDocsTitle')}
                    body={t('space.emptyShareDocsBody')}
                    className="w-full max-w-md mt-8"
                    links={[
                      { target: { page: 'explanation', anchor: 'spaces-members-availability' }, label: t('docs.availability') },
                      { target: { page: 'guides', anchor: 'share-files' }, label: t('docs.shareFiles') },
                      { target: { page: 'guides', anchor: 'share-a-folder' }, label: t('docs.shareFolder') },
                    ]}
                  />
                </div>
              </div>
            ) : (
              <>
                {shares.length > 0 && (
                  <div>
                    <div className="sticky top-0 z-10 bg-surface flex items-baseline gap-3 pt-1 pb-4">
                      <h2 className="text-2xl font-headline font-bold text-accent">{t('space.foldersShared')}</h2>
                      <span className="text-sm font-label text-secondary font-bold">
                        {t('space.folderCount', { count: shares.length })}
                      </span>
                    </div>
                    <div className="grid grid-cols-1 gap-4">
                      {shares.map((share) => {
                        const owner = members.find((m) => m.publicKey === share.owner) ?? null
                        return (
                          <ShareCard
                            key={share.owner + ':' + share.id}
                            share={share}
                            owner={owner}
                            selfProfile={profile}
                            onOpen={handleOpenShare}
                            onOpenInFinder={handleOpenInFinder}
                            onDelete={handleDeleteRequest}
                            onLocate={locate}
                            onMirror={handleMirrorRequest}
                            onUnmount={handleUnmount}
                            onPauseMirror={handlePauseMirror}
                            onResumeMirror={handleResumeMirror}
                          />
                        )
                      })}
                    </div>
                  </div>
                )}

                {showSpaceLoading(pane) ? (
                  <LoadingFiles label={t('space.loadingFiles')} />
                ) : error && files.length === 0 ? (
                  <div role="alert" className="bg-surface-container-lowest rounded-xl p-12 flex flex-col items-center justify-center text-center">
                    <div className="flex items-center gap-3 mb-3">
                      <Icon name="warning" size={32} className="text-error" />
                      <h2 className="text-2xl font-headline font-bold text-accent">{t('space.filesError')}</h2>
                    </div>
                    <p className="text-on-surface-variant max-w-md leading-relaxed mb-6">{t('space.filesErrorHint')}</p>
                    <button
                      type="button"
                      onClick={() => { void refresh() }}
                      className="inline-flex items-center gap-2 rounded-full bg-secondary-container px-6 py-2.5 font-label font-bold text-on-secondary-container hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      <Icon name="refresh" size={18} />
                      {t('space.filesRetry')}
                    </button>
                  </div>
                ) : files.length > 0 ? (
                  <div>
                    <div className="sticky top-0 z-10 bg-surface flex items-baseline gap-3 pt-1 pb-4">
                      <h2 className="text-2xl font-headline font-bold text-accent">{t('space.filesShared')}</h2>
                      <span className="text-sm font-label text-secondary font-bold">
                        {t('space.fileCount', { count: files.length })}
                      </span>
                    </div>
                    <div className="grid grid-cols-1 gap-4">
                      {files.map((file) => (
                        <FileCard
                          key={`${file.driveKey}-${file.path}`}
                          file={file}
                          decoration={getDecoration(file.path)}
                          seeded={isSeeded(file.path)}
                          onDownload={downloadFile}
                          onCancel={cancelDownload}
                          onPause={pauseDownload}
                          onReveal={handleReveal}
                          onUnshare={handleRemoveRequest}
                          onDiscardPartial={discardPartial}
                          onCancelPublish={handleCancelPublish}
                          members={members}
                          downloadSummary={getDownloadSummary(file.path)}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </div>

          <div className="flex flex-col gap-6 min-h-0 overflow-hidden pt-12">
            {!isLegacy && (
              <div className="shrink-0">
                <DropZone
                  onFilesSelected={(files) => addFiles(files)}
                  onFolderSelected={handleShareFolderRequest}
                  dragActive={dragActive}
                />
              </div>
            )}
            {/* People above size, the same order the folder screen's sidebar uses. Members is the
              one that folds and the one that grows, so it takes the flexible slot; Storage is a
              fixed three-line statement and sits under it. */}
            <MembersBox spaceId={spaceId} members={members} />
            <div className="shrink-0">
              <StorageIndicator spaceId={spaceId} />
            </div>
          </div>

          <DropOverlay active={dragActive} kind={dragKind} fileCount={fileCount} folderName={folderName} />
        </div>
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
