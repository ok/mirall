// Folder-share screen. One skeleton for all three roles: header (one primary + More), a work strip
// band that exists only while the folder is doing something, a controls row pinned on the listing,
// and two read-only tiles. Tiles state, the header acts, the strip acts for now.
//
// What the folder IS lives in useFolderViewModel, what it acts on in useShareActions, and the file
// half in FolderListPane. What is left here is the screen: which of those to show, and the two
// dialogs whose open state is the screen's own.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShareFiles } from '../hooks/useShareFiles.js'
import { usePeerDownloads } from '../hooks/usePeerDownloads.js'
import { useMembers } from '../hooks/useMembers.js'
import { useSpaces } from '../hooks/useSpaces.js'
import { useProfile } from '../hooks/useProfile.js'
import { useFilteredTree } from '../hooks/useFilteredTree.js'
import { useShareActions } from '../hooks/useShareActions.js'
import { useFolderViewModel } from '../hooks/useFolderViewModel.js'
import Button from '../components/primitives/Button.js'
import EntityHeader from '../components/layout/EntityHeader.js'
import ActionMenu, { type ActionMenuItemConfig } from '../components/widgets/ActionMenu.js'
import FolderListPane from '../components/widgets/FolderListPane.js'
import FolderWorkStrip from '../components/widgets/FolderWorkStrip.js'
import DeleteFolderShareModal from '../components/modals/DeleteFolderShareModal.js'
import EditFolderModal from '../components/modals/EditFolderModal.js'
import FolderPeopleCard from '../components/cards/FolderPeopleCard.js'
import FolderStatsCard from '../components/cards/FolderStatsCard.js'
import { setForeignMountEnabled, unmountForeignMount, useForeignMount } from '../hooks/useForeignMount.js'
import { useFolderCommands } from '../hooks/useFolderCommands.js'
import { useLocateShare } from '../hooks/useLocateShare.js'
import type { ShareWithRole } from '../hooks/useShares.js'
import type { ShareRole } from '../types.js'

interface FolderEyebrowProps {
  isYou: boolean
  ownerName: string
  spaceName: string | null
  role: ShareRole
  mirrorEnabled: boolean
}

function FolderEyebrow({ isYou, ownerName, spaceName, role, mirrorEnabled }: FolderEyebrowProps) {
  const { t } = useTranslation()
  return (
    <>
      {isYou ? t('share.sharedByYou') : t('share.ownedBy', { name: ownerName })}
      {spaceName !== null ? ' · ' + t('space.in', { name: spaceName }) : null}
      {role === 'mirrored'
        ? ' · ' + t('share.badgeMirrored') + ' · ' + (mirrorEnabled ? t('share.readOnly') : t('folder.paused'))
        : null}
    </>
  )
}

interface FolderHeaderActionsProps {
  role: ShareRole
  sourceMissing: boolean
  onMirror?: () => void
  onLocate: () => void
  onReveal: () => void
  menuItems: ActionMenuItemConfig[]
}

function FolderHeaderActions({ role, sourceMissing, onMirror, onLocate, onReveal, menuItems }: FolderHeaderActionsProps) {
  const { t } = useTranslation()
  if (role === 'browse') {
    return onMirror
      ? <Button icon="folder_download" onClick={onMirror}>{t('share.mirrorToDisk')}</Button>
      : null
  }
  return (
    <>
      {sourceMissing ? (
        <Button icon="folder_open" onClick={onLocate}>{t('share.locateFolder')}</Button>
      ) : (
        <Button icon="folder_open" onClick={onReveal}>{t('share.openInFinder')}</Button>
      )}
      <ActionMenu label={t('share.moreActions')} items={menuItems} ariaLabel={t('share.moreActions')} />
    </>
  )
}

interface FolderViewProps {
  spaceId: string
  /** Resolved from the live listing by the router, so it is current rather than a snapshot of the
   *  row that was clicked. Mount detail still comes from useOwnedMount / useForeignMount. */
  share: ShareWithRole
  onBack: () => void
  onMirror?: (share: ShareWithRole) => void
}

export default function FolderView({ spaceId, share, onBack, onMirror }: FolderViewProps) {
  const { t } = useTranslation()
  const { locate, relocate } = useLocateShare(spaceId)
  const { profile } = useProfile()
  const { members } = useMembers(spaceId)
  const { getDownloadSummary } = usePeerDownloads(spaceId)
  const { spaces } = useSpaces()
  const space = spaces.find((s) => s.spaceId === spaceId)
  const owner = members.find((m) => m.publicKey === share.owner) ?? null
  const isYou = share.role === 'mine'
  const {
    files, info, loading, error,
    getDecoration, isSeeded,
    downloadFile, revealFile,
    pauseDownload, cancelDownload, discardPartial,
  } = useShareFiles(spaceId, share.owner, share.id)
  // The worker reports whether it capped the rows. Never inferred from (fileCount > files.length):
  // on an incomplete peer read the count is itself partial, so that inference silently goes false
  // exactly when the listing was truncated.
  const listingTruncated = !loading && !error && !!info && info.truncated
  const { mount: foreignMount, status: foreignStatus } = useForeignMount(spaceId, share.role === 'mirrored' ? share.id : '')
  const [showDelete, setShowDelete] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const {
    filter, setFilter, deferredFilter,
    visibleTree, matched, allFolderPaths, anyExpanded,
    isExpanded, toggle, toggleAll,
  } = useFilteredTree(share.id, files)

  const {
    foreignEnabled, manualControls, ownedPaused, ownedPath, sourceMissing, ownerName,
    strips, overLimit, workAnnouncement, onDeviceCount, folderStatus, busy, filterableTotal,
  } = useFolderViewModel({
    spaceId, share, isYou, owner, profile, files, info, loading, error, getDecoration,
    listingTruncated, foreignMount, foreignStatus,
  })
  const {
    revealFolder, deleteShare, setPaused, unmount, rename, relocateTo, onStripAction,
  } = useShareActions({ spaceId, share, isYou, onBack, locate, relocate, setForeignMountEnabled, unmountForeignMount })

  const paused = isYou ? ownedPaused : !foreignEnabled
  // The same acts the header offers, reachable from the command palette while this folder is on
  // screen. Deliberately not the destructive pair: Delete and Unmount are gated on work that is
  // still running, and an Enter keypress in a search field is the wrong place to confirm either.
  useFolderCommands({
    name: share.name,
    role: share.role,
    paused,
    sourceMissing,
    canMirror: !!onMirror,
    onOpen: revealFolder,
    onLocate: () => { void locate(share) },
    onSetPaused: setPaused,
    onMirror: () => onMirror?.(share),
    onEdit: () => setShowEdit(true),
  })
  // Destructive entries are disabled while the folder is working — not the trigger, because Pause
  // lives in this menu and is the one control you reach for while it runs.
  const destructive: ActionMenuItemConfig = isYou
    ? {
      id: 'delete',
      label: t('share.deleteFolder'),
      icon: 'delete',
      variant: 'danger',
      disabled: busy,
      hint: busy ? t('share.notWhileSyncing') : undefined,
      onAction: () => setShowDelete(true),
    }
    : {
      id: 'unmount',
      label: t('share.unmountMirror'),
      icon: 'close',
      variant: 'danger',
      disabled: busy,
      hint: busy ? t('share.notWhileSyncing') : undefined,
      onAction: unmount,
    }
  const menuItems: ActionMenuItemConfig[] = [
    paused
      ? { id: 'resume', label: t('share.resumeSyncing'), icon: 'play_arrow', onAction: () => setPaused(false) }
      : { id: 'pause', label: t('share.pauseSyncing'), icon: 'pause', onAction: () => setPaused(true) },
    { id: 'edit', label: t('share.editFolder'), icon: 'edit', onAction: () => setShowEdit(true) },
    destructive,
  ]

  return (
    <div className="max-w-7xl mx-auto px-8 flex flex-col h-[calc(100vh-5rem-var(--banner-h,0px))]">
      <EntityHeader
        name={share.name}
        onBack={onBack}
        eyebrow={
          <FolderEyebrow
            isYou={isYou}
            ownerName={owner?.displayName || t('avatar.unknown')}
            spaceName={space ? space.name : null}
            role={share.role}
            mirrorEnabled={foreignEnabled}
          />
        }
        actions={
          <FolderHeaderActions
            role={share.role}
            sourceMissing={sourceMissing}
            onMirror={onMirror ? () => onMirror(share) : undefined}
            onLocate={() => { void locate(share) }}
            onReveal={revealFolder}
            menuItems={menuItems}
          />
        }
      />

      {/* The strips are a band, not a reserved slot: no strip, no height. Outside the scroll pane,
          so folder state can never scroll away from the folder it describes.
          The container itself is ALWAYS mounted because the over-limit notice below needs a live
          region that pre-exists: a role=status added to the DOM already-populated is not reliably
          announced. It is `absolute` while empty, so it still costs no height. */}
      <div className={`shrink-0 space-y-2${strips.length > 0 ? ' pb-4' : ''}`}>
        {strips.filter((strip) => strip.id !== 'over-limit').map((strip) => (
          <FolderWorkStrip key={strip.id} strip={strip} ownerName={ownerName} onAction={onStripAction} />
        ))}
        <div
          role="status"
          aria-live="polite"
          className={overLimit ? '' : 'sr-only'}
        >
          {overLimit ? <FolderWorkStrip strip={overLimit} ownerName={ownerName} onAction={onStripAction} /> : null}
        </div>
      </div>

      {/* The counts in the working strip change about twice a second, so it is deliberately NOT a
          live region — ProgressBar makes the same call for the same reason. This carries a
          count-free sentence instead, announced once when the scan starts and once when it ends. */}
      <div role="status" aria-live="polite" className="sr-only">
        {workAnnouncement}
      </div>

      {/* No `overflow-hidden` on either box: a `focus-visible:ring-2` paints OUTSIDE the border box,
          so any clipper flush against a focusable control shaves the ring off. `min-h-0` constrains
          the height; `min-w-0` keeps the automatic minimum size `overflow-hidden` was providing, so
          a long file name cannot stretch the 1fr track. Rings paint into the gutter and column gap. */}
      <div className="flex-1 min-h-0 grid grid-cols-1 min-[900px]:grid-cols-[1fr_300px] gap-8 pb-8">
        <FolderListPane
          filter={filter}
          setFilter={setFilter}
          deferredFilter={deferredFilter}
          matched={matched}
          filterableTotal={filterableTotal}
          anyExpanded={anyExpanded}
          allFolderPaths={allFolderPaths}
          toggleAll={toggleAll}
          visibleTree={visibleTree}
          isExpanded={isExpanded}
          toggle={toggle}
          loading={loading}
          error={error}
          files={files}
          sourceMissing={sourceMissing}
          owner={owner}
          isOwn={isYou}
          manualControls={manualControls}
          spaceId={spaceId}
          members={members}
          getDownloadSummary={getDownloadSummary}
          getDecoration={getDecoration}
          isSeeded={isSeeded}
          onDownload={downloadFile}
          onReveal={revealFile}
          onPause={pauseDownload}
          onCancel={cancelDownload}
          onDiscardPartial={discardPartial}
        />

        {/* `pr-4`: the same scrollbar gutter the list uses. Without it the tiles butt straight
            against their own scrollbar while the list sits 16px off its own. */}
        <div className="space-y-6 min-h-0 overflow-y-auto scrollbar-thin pr-4 pb-1">
          <FolderPeopleCard
            spaceId={spaceId}
            shareId={share.id}
            members={members}
            owner={owner}
            isYou={isYou}
            selfProfile={profile}
            selfPublicKey={profile?.publicKey ?? ''}
          />
          {info && (
            <FolderStatsCard
              folderName={share.name}
              totalBytes={info.totalBytes}
              fileCount={info.fileCount}
              onDevice={onDeviceCount}
              status={folderStatus}
            />
          )}
        </div>
      </div>

      <DeleteFolderShareModal
        isOpen={showDelete}
        folderName={share.name}
        spaceName={space?.name || ''}
        onClose={() => setShowDelete(false)}
        onDelete={async () => {
          await deleteShare()
          setShowDelete(false)
        }}
      />

      {showEdit && (
        <EditFolderModal
          isOwner={isYou}
          canRelocate={!isYou || sourceMissing}
          name={share.name}
          ownerName={ownerName}
          mountPath={isYou ? ownedPath : (foreignMount?.mountPath ?? null)}
          onRename={rename}
          onRelocate={relocateTo}
          onClose={() => setShowEdit(false)}
        />
      )}
    </div>
  )
}
