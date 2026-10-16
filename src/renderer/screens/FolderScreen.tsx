// Folder-share screen. One skeleton for all three roles: header (one primary + More), a work strip
// band that exists only while the folder is doing something, a controls row pinned on the listing,
// and two read-only tiles. Tiles state, the header acts, the strip acts for now.
//
// What the folder IS lives in useFolderViewModel, what it acts on in useShareActions, and the file
// half in FolderListPane. What is left here is the screen: which of those to show, and the two
// dialogs whose open state is the screen's own.
import { useState, type ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'
import { useShareFiles } from '../hooks/useShareFiles.js'
import { useTransferControls } from '../hooks/useTransferControls.js'
import { usePeerDownloads } from '../hooks/usePeerDownloads.js'
import { useFolderRecipients } from '../hooks/useFileRecipients.js'
import { useMembers } from '../hooks/useMembers.js'
import { useSpaces } from '../hooks/useSpaces.js'
import { useProfile } from '../hooks/useProfile.js'
import { useFilteredTree } from '../hooks/useFilteredTree.js'
import { useShareActions } from '../hooks/useShareActions.js'
import { useFolderViewModel } from '../hooks/useFolderViewModel.js'
import { useFolderMenu } from '../hooks/useFolderMenu.js'
import Button from '../components/primitives/Button.js'
import EntityHeader from '../components/layout/EntityHeader.js'
import ActionMenu, { type ActionMenuItemConfig } from '../components/primitives/ActionMenu.js'
import FolderListPane from '../components/folder/FolderListPane.js'
import FolderStripBand from '../components/folder/FolderStripBand.js'
import DeleteFolderShareModal from '../components/modals/DeleteFolderShareModal.js'
import EditFolderModal from '../components/modals/EditFolderModal.js'
import FolderSidebar from '../components/folder/FolderSidebar.js'
import { setForeignMountEnabled, unmountForeignMount, useForeignMount } from '../hooks/useForeignMount.js'
import { useFolderCommands } from '../hooks/useFolderCommands.js'
import { useLocateShare } from '../hooks/useLocateShare.js'
import { useFolderBatch, type FolderBatch } from '../hooks/useFolderBatch.js'
import SelectionBar from '../components/batch/SelectionBar.js'
import { useDownloadTo, type DownloadTo } from '../hooks/useDownloadTo.js'
import type { ShareWithRole } from '../hooks/useShares.js'
import type { ShareRole } from '../types/types.js'

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

// Null on a folder that offers no selection, so the band and the pane keep their resting shape.
function FolderSelectionBar({ batch, downloadTo }: { batch: FolderBatch, downloadTo: DownloadTo }) {
  if (!batch.selection) return null
  return (
    <SelectionBar
      selecting={batch.selecting}
      summary={batch.summary}
      matchingCount={batch.matchingCount}
      downloadTo={downloadTo}
      onDownload={batch.downloadSelected}
      onDeselectHidden={batch.deselectHidden}
      onDone={batch.end}
    />
  )
}

interface FolderDialogsProps {
  showDelete: boolean
  showEdit: boolean
  share: ShareWithRole
  spaceName: string
  isYou: boolean
  sourceMissing: boolean
  ownerName: string
  mountPath: string | null
  onCloseDelete: () => void
  onCloseEdit: () => void
  onDelete: () => Promise<void>
  onRename: ComponentProps<typeof EditFolderModal>['onRename']
  onRelocate: ComponentProps<typeof EditFolderModal>['onRelocate']
}

// The two dialogs whose open state is the screen's own.
function FolderDialogs({ showDelete, showEdit, share, spaceName, isYou, sourceMissing, ownerName, mountPath, onCloseDelete, onCloseEdit, onDelete, onRename, onRelocate }: FolderDialogsProps) {
  return (
    <>
      <DeleteFolderShareModal
        isOpen={showDelete}
        folderName={share.name}
        spaceName={spaceName}
        onClose={onCloseDelete}
        onDelete={async () => {
          await onDelete()
          onCloseDelete()
        }}
      />
      {showEdit && (
        <EditFolderModal
          isOwner={isYou}
          canRelocate={!isYou || sourceMissing}
          name={share.name}
          ownerName={ownerName}
          mountPath={mountPath}
          onRename={onRename}
          onRelocate={onRelocate}
          onClose={onCloseEdit}
        />
      )}
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

export default function FolderScreen({ spaceId, share, onBack, onMirror }: FolderViewProps) {
  const { t } = useTranslation()
  const { locate, relocate } = useLocateShare(spaceId)
  const { profile } = useProfile()
  const { members } = useMembers(spaceId)
  const { getDownloadSummary } = usePeerDownloads(spaceId)
  const getRecipients = useFolderRecipients(spaceId, share.id)
  const { spaces } = useSpaces()
  const space = spaces.find((s) => s.spaceId === spaceId)
  const owner = members.find((m) => m.publicKey === share.owner) ?? null
  const isYou = share.role === 'mine'
  const {
    files, info, loading, error,
    getDecoration, isSeeded, markSeeded,
    downloadFile, revealFile,
  } = useShareFiles(spaceId, share.owner, share.id)
  const { cancelDownload, pauseDownload } = useTransferControls()
  // The worker reports whether it capped the rows. Never inferred from (fileCount > files.length):
  // on an incomplete peer read the count is itself partial, so that inference silently goes false
  // exactly when the listing was truncated.
  const listingTruncated = !loading && !error && !!info && info.truncated
  const { mount: foreignMount, status: foreignStatus } = useForeignMount(spaceId, share.role === 'mirrored' ? share.id : '')
  const [showDelete, setShowDelete] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const tree = useFilteredTree(share.id, files)
  const downloadTo = useDownloadTo(space)
  const batch = useFolderBatch({ spaceId, share, offered: share.role === 'browse', files, tree, getDecoration, markSeeded, downloadTo })

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
  const menuItems = useFolderMenu({
    isYou,
    paused,
    busy,
    setPaused,
    unmount,
    onDelete: () => setShowDelete(true),
    onEdit: () => setShowEdit(true),
  })

  return (
    <div className="max-w-(--breakpoint-2xl) mx-auto px-8 flex flex-col h-[calc(100vh-5rem-var(--banner-h,0px))]">
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

      <FolderStripBand
        strips={strips}
        overLimit={overLimit}
        ownerName={ownerName}
        onAction={onStripAction}
        workAnnouncement={workAnnouncement}
        batch={batch.progress}
        onCancelBatch={batch.cancelAll}
      />

      {/* No `overflow-hidden` on either box: a `focus-visible:ring-2` paints OUTSIDE the border box,
          so any clipper flush against a focusable control shaves the ring off. `min-h-0` constrains
          the height; `min-w-0` keeps the automatic minimum size `overflow-hidden` was providing, so
          a long file name cannot stretch the 1fr track. Rings paint into the gutter and column gap. */}
      <div className="flex-1 min-h-0 grid grid-cols-[1fr_300px] gap-8 pb-8">
        <FolderListPane
          {...tree}
          filterableTotal={filterableTotal}
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
          getRecipients={getRecipients}
          ownerKey={share.owner}
          getDecoration={getDecoration}
          isSeeded={isSeeded}
          onDownload={downloadFile}
          downloadTo={downloadTo}
          onReveal={revealFile}
          onPause={pauseDownload}
          onCancel={cancelDownload}
          selection={batch.selection}
          selectAll={batch.selectAll}
          bar={<FolderSelectionBar batch={batch} downloadTo={downloadTo} />}
        />

        <FolderSidebar
          spaceId={spaceId}
          share={share}
          members={members}
          owner={owner}
          isYou={isYou}
          profile={profile}
          info={info}
          onDeviceCount={onDeviceCount}
          folderStatus={folderStatus}
        />
      </div>

      <FolderDialogs
        showDelete={showDelete}
        showEdit={showEdit}
        share={share}
        spaceName={space?.name || ''}
        isYou={isYou}
        sourceMissing={sourceMissing}
        ownerName={ownerName}
        mountPath={isYou ? ownedPath : (foreignMount?.mountPath ?? null)}
        onCloseDelete={() => setShowDelete(false)}
        onCloseEdit={() => setShowEdit(false)}
        onDelete={deleteShare}
        onRename={rename}
        onRelocate={relocateTo}
      />
    </div>
  )
}
