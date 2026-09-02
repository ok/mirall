// Space screen: loose files and folder shares with drag-drop adding, transfer controls, member presence, and invites.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FileEntry } from '../types.js'
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
import { useToast } from '../components/toast/useToast.js'
import { request } from '../ipc.js'
import ActionMenu from '../components/widgets/ActionMenu.js'
import InviteModal from '../components/modals/InviteModal.js'
import EditSpaceModal from '../components/modals/EditSpaceModal.js'
import Icon from '../components/primitives/Icon.js'
import IconButton from '../components/primitives/IconButton.js'
import Button from '../components/primitives/Button.js'
import Avatar from '../components/primitives/Avatar.js'
import DocsCard from '../components/widgets/DocsCard.js'
import { SPACE_ACTION_EVENT, type SpaceAction } from '../space-actions.js'
import { showSpaceEmptyState, showSpaceLoading } from '../spaceContentState.js'

interface SpaceViewProps {
  spaceId: string
  onBack: () => void
  onManageStorage: () => void
  onOpenShare?: (share: ShareWithRole) => void
}

export default function SpaceView({ spaceId, onBack, onManageStorage, onOpenShare }: SpaceViewProps) {
  const { t } = useTranslation()
  const { profile } = useProfile()
  const {
    files,
    loading,
    error,
    refresh,
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
  const [showInviteModal, setShowInviteModal] = useState(false)
  const [showApproval, setShowApproval] = useState(false)
  const [showLeaveModal, setShowLeaveModal] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const [fileToRemove, setFileToRemove] = useState<FileEntry | null>(null)
  const [folderPathForShare, setFolderPathForShare] = useState<string | null>(null)
  const [shareToDelete, setShareToDelete] = useState<ShareWithRole | null>(null)
  const [shareToMirror, setShareToMirror] = useState<ShareWithRole | null>(null)
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
      setFolderPathForShare(droppedPath)
      return
    }
    const picked = await window.bridge.browseShareFolder()
    if (picked) setFolderPathForShare(picked)
  }

  // Both list sources feed one pane; see spaceContentState.js for why emptiness needs both.
  const pane = {
    filesLoading: loading,
    sharesLoading,
    filesError: error,
    fileCount: files.length,
    shareCount: shares.length,
  }

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
      const code = err instanceof Error ? (err as Error & { code?: string }).code : undefined
      const message = err instanceof Error ? err.message : String(err)
      toast.error(code === 'CREATOR_DIVERGENCE_UNRESOLVED' ? t('space.approveBlockedDivergence') : message)
    } finally {
      clearBusy(pk)
    }
  }

  async function handleDeny(pk: string) {
    if (busy.has(pk)) return
    markBusy(pk)
    try {
      await denyMember(spaceId, pk)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      clearBusy(pk)
    }
  }

  // The row handlers below are useCallback'd because they are props of memoized rows (ShareCard,
  // FileCard): an identity that changes every render defeats the memo, and the decoration
  // heartbeat re-renders this screen once a second for as long as a transfer is live.
  const handleLocate = useCallback(async (share: ShareWithRole) => {
    const picked = await window.bridge.browseShareFolder()
    if (!picked) return
    try {
      await request('owned-folder:relocate', { spaceId, shareId: share.id, mountPath: picked })
      toast.success(t('share.locateSuccess', { name: share.name }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }, [spaceId, toast, t])

  const handleOpenShare = useCallback((share: ShareWithRole) => { onOpenShare?.(share) }, [onOpenShare])

  const handleOpenInFinder = useCallback(async (share: ShareWithRole) => {
    try { await request('share:reveal-folder', { spaceId, ownerKey: share.owner, shareId: share.id }) } catch {}
  }, [spaceId])

  const handleDeleteRequest = useCallback((share: ShareWithRole) => { setShareToDelete(share) }, [])
  const handleMirrorRequest = useCallback((share: ShareWithRole) => { setShareToMirror(share) }, [])

  const handleUnmount = useCallback(async (share: ShareWithRole) => {
    await unmountForeignMount(share.spaceId, share.id)
  }, [])

  const handlePauseMirror = useCallback(async (share: ShareWithRole) => {
    await setForeignMountEnabled(share.spaceId, share.id, false)
  }, [])

  const handleResumeMirror = useCallback(async (share: ShareWithRole) => {
    await setForeignMountEnabled(share.spaceId, share.id, true)
  }, [])

  useEffect(() => {
    function handle(event: Event) {
      const ev = event as CustomEvent<ShareWithRole>
      if (ev.detail && ev.detail.spaceId === spaceId) {
        setShareToMirror(ev.detail)
      }
    }
    window.addEventListener('mirall:open-mirror-modal', handle)
    return () => window.removeEventListener('mirall:open-mirror-modal', handle)
  }, [spaceId])

  useEffect(() => {
    function handle(event: Event) {
      const action = (event as CustomEvent<SpaceAction>).detail
      // Leave is the only action a legacy space keeps: everything else writes, and the data layer
      // refuses it (SPACE_UNSUPPORTED) because there is no content key and no way to mint one.
      if (action === 'leave') { setShowLeaveModal(true); return }
      if (isPending || isLegacy) return
      if (action === 'add-files') fileInputRef.current?.click()
      else if (action === 'add-folder') void handleShareFolderRequest('')
      else if (action === 'invite') setShowInviteModal(true)
      else if (action === 'edit') setShowEditModal(true)
    }
    window.addEventListener(SPACE_ACTION_EVENT, handle)
    return () => window.removeEventListener(SPACE_ACTION_EVENT, handle)
  }, [isPending, isLegacy])

  function handleInvite() {
    if (isPending || isLegacy) return
    setShowInviteModal(true)
  }

  async function handleCancelRequest() {
    await leaveSpace(spaceId)
    onBack()
  }

  async function handleLeave() {
    await leaveSpace(spaceId)
  }

  async function handleUnshareFile() {
    if (!fileToRemove) return
    await unshareFile(fileToRemove.path)
    setFileToRemove(null)
  }

  const handleReveal = useCallback(async (file: FileEntry) => {
    await revealFile(file.path)
  }, [revealFile])

  const handleRemoveRequest = useCallback((file: FileEntry) => { setFileToRemove(file) }, [])

  const handleCancelPublish = useCallback((file: FileEntry) => { void cancelPublish(file.path) }, [cancelPublish])

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
      <div className="shrink-0 pt-8 pb-4">
        <div className="flex items-start gap-4 mb-2">
          <IconButton
            icon="arrow_back"
            onClick={onBack}
            ariaLabel={t('actions.back')}
            className="mt-1 shrink-0"
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3">
              <h1 className="text-4xl font-headline font-extrabold text-accent tracking-tighter leading-tight truncate pb-1.5">
                {space?.name || t('space.fallbackName')}
              </h1>
              {isLegacy && (
                <span className="shrink-0 inline-flex items-center px-2.5 py-1 rounded-full bg-error-container text-on-error-container text-xs font-bold border border-outline">
                  {t('space.legacyBadge')}
                </span>
              )}
            </div>
          </div>
          <div className="flex gap-3 mt-2 shrink-0">
            {isPending ? (
              // Not a member yet — expose nothing member-only (invite/edit/storage),
              // just a way to withdraw the request.
              <Button variant="secondary" icon="close" onClick={handleCancelRequest}>
                {t('space.cancelRequest')}
              </Button>
            ) : (
              <>
                <Button icon="group_add" onClick={handleInvite} disabled={isLegacy}>
                  {t('space.inviteShort')}
                </Button>
                <ActionMenu
                  label={t('space.more')}
                  items={[
                    {
                      id: 'favorite',
                      label: space?.favorite ? t('space.removeFavorite') : t('space.addFavorite'),
                      icon: 'star',
                      iconFilled: space?.favorite,
                      onAction: () => toggleFavorite(spaceId),
                    },
                    {
                      id: 'edit',
                      label: t('space.edit'),
                      icon: 'edit',
                      disabled: isLegacy,
                      onAction: () => setShowEditModal(true),
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
                      onAction: () => setShowLeaveModal(true),
                    },
                  ]}
                />
              </>
            )}
          </div>
        </div>
      </div>

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
            onReview={() => setShowApproval(true)}
          />
        </div>
      )}

      {space?.status === 'pending' ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center pb-8">
          {(() => {
            const inviters = members.filter((m) => m.publicKey !== profile?.publicKey)
            return inviters.length > 0 ? (
              <div className="flex items-center -space-x-3 mb-5">
                {inviters.slice(0, 3).map((m) => (
                  <Avatar key={m.publicKey} src={m.avatar} displayName={m.displayName} size="xl" ring="surface-container-lowest" />
                ))}
              </div>
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
          /* `relative` makes this pane the containing block for the `sr-only` spans inside the
             rows (a file's full name, via FileName). They are `position: absolute`, so without it
             they resolve against the grid above — which no longer clips anything — and a row
             below the fold drops its 1px span past the viewport bottom, growing the DOCUMENT into
             an OS scrollbar down the whole window. FolderView's pane carries it for the same
             reason. The 4px of interior room is for a focused card's ring, cancelled by an equal
             negative margin so no card moves; `pr-4` is the shared scrollbar gutter. */
          className={`relative overflow-y-auto scrollbar-thin min-h-0 -mx-1 -mt-1 pl-1 pt-1 pb-4 space-y-8${filesOverflow ? ' pr-4' : ' pr-1'}`}
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
                          onLocate={handleLocate}
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
                folderSupportEnabled
                onFolderSelected={handleShareFolderRequest}
                dragActive={dragActive}
              />
            </div>
          )}
          <div className="shrink-0">
            <StorageIndicator spaceId={spaceId} />
          </div>
          <MembersBox spaceId={spaceId} members={members} />
        </div>

        <DropOverlay active={dragActive} kind={dragKind} fileCount={fileCount} folderName={folderName} />
      </div>
      )}

      <ApprovalModal
        isOpen={showApproval}
        requests={requests}
        busyKeys={busy}
        onApprove={handleApprove}
        onDeny={handleDeny}
        onClose={() => setShowApproval(false)}
      />
      <InviteModal
        isOpen={showInviteModal}
        onCreate={(opts) => createInvite(spaceId, opts)}
        onClose={() => setShowInviteModal(false)}
      />
      <LeaveSpaceModal
        isOpen={showLeaveModal}
        spaceName={space?.name || t('space.fallbackName')}
        spaceId={spaceId}
        onClose={() => setShowLeaveModal(false)}
        onLeave={handleLeave}
        onComplete={onBack}
      />
      {space && showEditModal && (
        <EditSpaceModal
          space={space}
          onSave={updateSpace}
          onClose={() => setShowEditModal(false)}
        />
      )}
      <RemoveFileModal
        isOpen={fileToRemove !== null}
        filePath={fileToRemove?.path || ''}
        onClose={() => setFileToRemove(null)}
        onRemove={handleUnshareFile}
      />
      <AddFolderShareModal
        isOpen={folderPathForShare !== null}
        spaceId={spaceId}
        spaceName={space?.name || t('space.fallbackName')}
        existingShareNames={shares.filter((s) => s.role === 'mine').map((s) => s.name)}
        initialMountPath={folderPathForShare ?? ''}
        onClose={() => setFolderPathForShare(null)}
        onCreated={() => setFolderPathForShare(null)}
      />
      <DeleteFolderShareModal
        isOpen={shareToDelete !== null}
        folderName={shareToDelete?.name ?? ''}
        spaceName={space?.name || t('space.fallbackName')}
        mountPath={null}
        onClose={() => setShareToDelete(null)}
        onDelete={async () => {
          if (!shareToDelete) return
          await request('owned-folder:delete', { spaceId, shareId: shareToDelete.id })
          setShareToDelete(null)
        }}
      />
      {shareToMirror && (
        <MirrorFolderModal
          isOpen
          share={shareToMirror}
          owner={members.find((m) => m.publicKey === shareToMirror.owner) ?? null}
          onClose={() => setShareToMirror(null)}
          onMounted={() => setShareToMirror(null)}
        />
      )}
    </div>
  )
}
