// Folder-share screen. One skeleton for all three roles: header (one primary + More), a work strip
// band that exists only while the folder is doing something, a controls row pinned on the listing,
// and two read-only tiles. Tiles state, the header acts, the strip acts for now.
import { useState, useEffect, useMemo, useRef, useDeferredValue } from 'react'
import { useTranslation } from 'react-i18next'
import { useShareFiles } from '../hooks/useShareFiles.js'
import { usePeerDownloads } from '../hooks/usePeerDownloads.js'
import { useMembers } from '../hooks/useMembers.js'
import { useSpaces } from '../hooks/useSpaces.js'
import { useProfile } from '../hooks/useProfile.js'
import { useTreeExpansion } from '../hooks/useTreeExpansion.js'
import Icon from '../components/primitives/Icon.js'
import IconButton from '../components/primitives/IconButton.js'
import Button from '../components/primitives/Button.js'
import ActionMenu, { type ActionMenuItemConfig } from '../components/widgets/ActionMenu.js'
import FolderTree from '../components/widgets/FolderTree.js'
import FolderWorkStrip from '../components/widgets/FolderWorkStrip.js'
import FolderControlsRow from '../components/widgets/FolderControlsRow.js'
import LoadingFiles from '../components/widgets/LoadingFiles.js'
import DeleteFolderShareModal from '../components/modals/DeleteFolderShareModal.js'
import EditFolderModal from '../components/modals/EditFolderModal.js'
import FolderPeopleCard from '../components/cards/FolderPeopleCard.js'
import FolderStatsCard from '../components/cards/FolderStatsCard.js'
import { buildFileTree, collectFolderPaths, topLevelFolderPaths } from '../fileTree.js'
import { filterTree } from '../folderFilter.js'
import { deriveStrips } from '../folderStrips.js'
import { deriveFolderStatus } from '../folderStatus.js'
import { deriveMirrorSync } from '../mirrorSync.js'
import { request } from '../ipc.js'
import { setForeignMountEnabled, unmountForeignMount, useForeignMount } from '../hooks/useForeignMount.js'
import { useOwnedMount } from '../hooks/useFolderMount.js'
import { useIndexProgress } from '../hooks/useIndexProgress.js'
import { deriveIndexSummary } from '../indexSummary.js'
import { useHasVerticalOverflow } from '../hooks/useHasVerticalOverflow.js'
import { useToast } from '../components/toast/useToast.js'
import type { ShareWithRole } from '../hooks/useShares.js'
import type { FileTreeNode } from '../types.js'

interface FolderViewProps {
  spaceId: string
  share: ShareWithRole
  onBack: () => void
  onMirror?: (share: ShareWithRole) => void
  onUnmounted?: () => void
  onRenamed?: (name: string) => void
}

export default function FolderView({ spaceId, share, onBack, onMirror, onUnmounted, onRenamed }: FolderViewProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const { profile } = useProfile()
  const { members } = useMembers(spaceId)
  const { getDownloadSummary } = usePeerDownloads(spaceId)
  const { spaces } = useSpaces()
  const space = spaces.find((s) => s.spaceId === spaceId)
  const owner = members.find((m) => m.publicKey === share.owner) ?? null
  const isYou = share.role === 'mine'
  const {
    files, info, loading, error,
    downloadFile, revealFile,
    pauseDownload, cancelDownload, discardPartial,
  } = useShareFiles(spaceId, share.owner, share.id, share.role)
  // The worker reports whether it capped the rows. Never inferred from (fileCount > files.length):
  // on an incomplete peer read the count is itself partial, so that inference silently goes false
  // exactly when the listing was truncated.
  const listingTruncated = !loading && !error && !!info && info.truncated
  const { mount: foreignMount, status: foreignStatus } = useForeignMount(spaceId, share.role === 'mirrored' ? share.id : '')
  const { ref: filesRef, hasOverflow: filesOverflow } = useHasVerticalOverflow<HTMLDivElement>()
  const [showDelete, setShowDelete] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const [filter, setFilter] = useState('')

  // The tree is derived from the flat file list; expansion state is separate and keyed by
  // stable folder paths, so it survives every rebuild (incl. live progress ticks).
  const tree = useMemo<FileTreeNode[]>(() => buildFileTree(files), [files])
  const { expanded, isExpanded, toggle, expandAll, collapseAll, hasStored } = useTreeExpansion(share.id)
  // Filtering a 5,000-row tree on every keystroke is two O(n) walks — cheap — but the RENDER of
  // what comes back is not, so the typed value stays responsive while the tree lags a frame.
  const deferredFilter = useDeferredValue(filter)
  const { nodes: visibleTree, matched, revealPaths } = useMemo(() => filterTree(tree, deferredFilter), [tree, deferredFilter])
  const allFolderPaths = useMemo<string[]>(() => collectFolderPaths(visibleTree), [visibleTree])
  const anyExpanded = allFolderPaths.some(isExpanded)
  // Expansion has exactly one home — the session store — so a disclosure button always toggles what
  // it says it toggles. A reveal writes THROUGH it, and the pre-filter set is snapshotted, so
  // clearing the filter puts back what the user had. An override read on top of the store would
  // have made every chevron under a filter a no-op whose aria-expanded never changed.
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  const preFilterRef = useRef<Set<string> | null>(null)
  const revealedForRef = useRef<string | null>(null)
  useEffect(() => {
    const term = deferredFilter.trim()
    if (!term) {
      const snapshot = preFilterRef.current
      preFilterRef.current = null
      revealedForRef.current = null
      if (snapshot) expandAll([...snapshot])
      return
    }
    if (!preFilterRef.current) preFilterRef.current = new Set(expandedRef.current)
    // Once per term, not once per rebuild: the tree is rebuilt on every progress tick, and
    // re-applying the reveal each time would undo a branch the user collapsed under the filter.
    if (!revealPaths || revealedForRef.current === term) return
    revealedForRef.current = term
    expandAll([...new Set([...preFilterRef.current, ...revealPaths])])
  }, [deferredFilter, revealPaths, expandAll])
  // Seed the default (top-level folders open) once, only if nothing was set this session.
  const seededRef = useRef(false)
  useEffect(() => {
    if (seededRef.current || hasStored() || tree.length === 0) return
    seededRef.current = true
    const top = topLevelFolderPaths(tree)
    if (top.length) expandAll(top)
  }, [tree, hasStored, expandAll])

  const foreignEnabled = share.role === 'mirrored' && (foreignMount?.enabled ?? true) && foreignStatus !== 'paused'
  const manualControls = share.role === 'browse'
  // Live while this view is mounted: useOwnedMount re-derives from owned-folder:list-all (a live
  // mountRootAvailable disk check) on every mount-status event — the useShares projection covers
  // SpaceView only, and the `share` prop is a frozen navigation snapshot (its fallback covers the
  // first render before derive() resolves).
  const { status: ownedStatus, indexPaused, scanning, mountPath: ownedPath } = useOwnedMount(spaceId, isYou ? share.id : '')
  // The scan's queue depth, which the file rows cannot show: a queued file has no catalog entry
  // yet, so it has no row. Ours reports locally; a peer's is re-announced by its owner, so it is
  // only meaningful while they are reachable — an owner that drops mid-scan sends no final frame.
  const indexProgress = useIndexProgress(spaceId, share.id, {
    own: isYou,
    ownerKey: share.owner,
    live: isYou || (owner != null && owner.online !== false),
  })
  // Memoised on its inputs: deriveIndexSummary returns a fresh object every call, and an unstable
  // `indexing` would make every downstream useMemo that depends on it miss on every render.
  const indexing = useMemo(
    () => deriveIndexSummary(indexProgress, { indexPaused, scanning }),
    [indexProgress, indexPaused, scanning],
  )
  const sourceMissing = isYou && (ownedStatus ?? share.mountStatus) === 'mount-point-gone'
  const mirrorSync = useMemo(
    () => (share.role === 'mirrored' ? deriveMirrorSync(files, { truncated: listingTruncated, enabled: foreignEnabled }) : null),
    [share.role, files, listingTruncated, foreignEnabled],
  )
  const ownerName = isYou
    ? (profile?.displayName || t('avatar.unknown'))
    : (owner?.displayName || t('avatar.unknown'))

  const strips = useMemo(() => deriveStrips({
    role: share.role,
    isYou,
    loading,
    error: !!error,
    sourceMissing,
    indexing,
    foreignEnabled,
    mirrorSync,
    ownerOnline: owner?.online !== false,
    listing: listingTruncated && info
      ? { truncated: true, shown: files.length, total: info.fileCount, limit: info.fileLimit ?? files.length }
      : null,
  }), [share.role, isYou, loading, error, sourceMissing, indexing, foreignEnabled, mirrorSync, owner, listingTruncated, info, files.length])

  const overLimit = strips.find((strip) => strip.id === 'over-limit') ?? null
  const working = strips.find((strip) => strip.id === 'working') ?? null
  const peerWorking = strips.find((strip) => strip.id === 'peer-indexing') ?? null
  // One count-free sentence for "work started / work ended", so it is announced twice rather than
  // twice a second. It is the ONLY announcement of a working folder: the strip carrying the numbers
  // is deliberately not a live region, and the tile does not repeat what the strip says. Derived
  // from the strips themselves so the two can never disagree — a paused mirror whose rows have not
  // settled yet must not announce that it is syncing.
  const workAnnouncement = working?.data?.kind === 'indexing'
    ? t('folder.indexingAnnounce')
    : working?.data?.kind === 'mirroring'
      ? t('folder.syncingAnnounce', { owner: ownerName })
      : peerWorking
        ? t('folder.indexingAnnouncePeer', { owner: ownerName })
        : ''

  const folderStatus = deriveFolderStatus({
    role: share.role,
    sourceMissing,
    indexPaused,
    mirrorEnabled: foreignEnabled,
    indexing: indexing.active,
    // Same rule the strip applies: with the owner away nothing is being fetched, so the tile must
    // not read "Syncing" beside a strip that says they are offline.
    mirrorSyncing: !!mirrorSync?.active && owner?.online !== false,
  })
  // A count only a mirror can report honestly: an owner holds every file by definition, and a
  // browser holds none, so the qualifier would be noise in both.
  const onDeviceCount = share.role === 'mirrored' && !listingTruncated ? (mirrorSync?.onDevice ?? null) : null
  // Only OUR OWN running work gates the destructive entry, and only while it is not paused. A
  // mirror's sync is the owner's doing and can last as long as they keep adding files — disabling
  // Unmount for its duration would leave the user with a dead control while the same action still
  // works from the folder card on the space screen.
  const busy = isYou && indexing.active && !indexing.paused
  const filterableTotal = listingTruncated ? files.length : (info?.fileCount ?? files.length)

  async function handleRevealFolder() {
    try {
      await request('share:reveal-folder', { spaceId, ownerKey: share.owner, shareId: share.id })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleLocate() {
    const picked = await window.bridge.browseShareFolder()
    if (!picked) return
    try {
      await request('owned-folder:relocate', { spaceId, shareId: share.id, mountPath: picked })
      toast.success(t('share.locateSuccess', { name: share.name }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleDelete() {
    try {
      await request('owned-folder:delete', { spaceId, shareId: share.id })
      onBack()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  // One handler behind both surfaces (the strip and the menu), so no state can exist in one and
  // not the other. Which durable flag it writes is the only thing the role changes.
  async function setPaused(paused: boolean) {
    try {
      if (isYou) await request(paused ? 'owned-folder:pause-index' : 'owned-folder:resume-index', { spaceId, shareId: share.id })
      else await setForeignMountEnabled(spaceId, share.id, !paused)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleUnmount() {
    try {
      await unmountForeignMount(spaceId, share.id)
      onUnmounted?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleRename(name: string) {
    await request('share:rename', { spaceId, shareId: share.id, name })
    // `share` is a frozen navigation snapshot, so the header would keep the old name until the
    // user left the screen and came back. The router owns that state; hand the new name up.
    onRenamed?.(name)
    toast.success(t('share.renameSuccess', { name }))
  }

  async function handleRelocate(mountPath: string) {
    if (isYou) {
      await request('owned-folder:relocate', { spaceId, shareId: share.id, mountPath })
      toast.success(t('share.locateSuccess', { name: share.name }))
      return
    }
    await request('foreign-folder:relocate', { spaceId, shareId: share.id, mountPath })
    toast.success(t('share.mirrorLocationSuccess'))
  }

  function handleStripAction(action: 'locate' | 'resume' | 'pause') {
    if (action === 'locate') void handleLocate()
    else void setPaused(action === 'pause')
  }

  const paused = isYou ? indexPaused : !foreignEnabled
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
      onAction: handleUnmount,
    }
  const menuItems: ActionMenuItemConfig[] = [
    paused
      ? { id: 'resume', label: t('share.resumeSyncing'), icon: 'play_arrow', onAction: () => void setPaused(false) }
      : { id: 'pause', label: t('share.pauseSyncing'), icon: 'pause', onAction: () => void setPaused(true) },
    { id: 'edit', label: t('share.editFolder'), icon: 'edit', onAction: () => setShowEdit(true) },
    destructive,
  ]

  return (
    <div className="max-w-7xl mx-auto px-8 flex flex-col h-[calc(100vh-5rem-var(--banner-h,0px))]">
      <div className="shrink-0 pt-8 pb-4">
        <div className="flex items-start gap-4">
          <IconButton
            icon="arrow_back"
            onClick={onBack}
            ariaLabel={t('actions.back')}
            className="mt-1 shrink-0"
          />
          <div className="min-w-0 flex-1">
            <h1 className="text-4xl font-headline font-extrabold text-accent tracking-tighter leading-tight truncate pb-1.5">
              {share.name}
            </h1>
            <p className="text-xs font-bold text-secondary tracking-wide uppercase mt-1">
              {isYou
                ? t('share.sharedByYou')
                : t('share.ownedBy', { name: owner?.displayName || t('avatar.unknown') })}
              {space ? ' · ' + t('space.in', { name: space.name }) : null}
              {share.role === 'mirrored'
                ? ' · ' + t('share.badgeMirrored') + ' · ' + (foreignEnabled ? t('share.readOnly') : t('folder.paused'))
                : null}
            </p>
          </div>
          <div className="flex gap-3 mt-2 shrink-0">
            {share.role === 'browse' ? (
              onMirror && (
                <Button icon="folder_download" onClick={() => onMirror(share)}>
                  {t('share.mirrorToDisk')}
                </Button>
              )
            ) : (
              <>
                {sourceMissing ? (
                  <Button icon="folder_open" onClick={handleLocate}>
                    {t('share.locateFolder')}
                  </Button>
                ) : (
                  <Button icon="folder_open" onClick={handleRevealFolder}>
                    {t('share.openInFinder')}
                  </Button>
                )}
                <ActionMenu
                  label={t('share.moreActions')}
                  items={menuItems}
                  ariaLabel={t('share.moreActions')}
                />
              </>
            )}
          </div>
        </div>
      </div>

      {/* The strips are a band, not a reserved slot: no strip, no height. Outside the scroll pane,
          so folder state can never scroll away from the folder it describes.
          The container itself is ALWAYS mounted because the over-limit notice below needs a live
          region that pre-exists: a role=status added to the DOM already-populated is not reliably
          announced. It is `absolute` while empty, so it still costs no height. */}
      <div className={`shrink-0 space-y-2${strips.length > 0 ? ' pb-4' : ''}`}>
        {strips.filter((strip) => strip.id !== 'over-limit').map((strip) => (
          <FolderWorkStrip key={strip.id} strip={strip} ownerName={ownerName} onAction={handleStripAction} />
        ))}
        <div
          role="status"
          aria-live="polite"
          className={overLimit ? '' : 'sr-only'}
        >
          {overLimit ? <FolderWorkStrip strip={overLimit} ownerName={ownerName} onAction={handleStripAction} /> : null}
        </div>
      </div>

      {/* The counts in the working strip change about twice a second, so it is deliberately NOT a
          live region — ProgressBar makes the same call for the same reason. This carries a
          count-free sentence instead, announced once when the scan starts and once when it ends. */}
      <div role="status" aria-live="polite" className="sr-only">
        {workAnnouncement}
      </div>

      {/* No `overflow-hidden` on either box: a `focus-visible:ring-2` is painted OUTSIDE the border
          box, so any clipper flush against a focusable control shaves the ring off — which is what
          ate the filter field's left edge and Expand all's right edge. `min-h-0` is what actually
          constrains the height here, and `min-w-0` keeps the automatic minimum size that
          `overflow-hidden` was silently providing, so a long file name still can't stretch the
          1fr track. The rings now paint into the page gutter and the column gap, which are empty. */}
      <div className="flex-1 min-h-0 grid grid-cols-1 min-[900px]:grid-cols-[1fr_300px] gap-8 pb-8">
        <div className="flex flex-col min-w-0 min-h-0">
          <FolderControlsRow
            value={filter}
            onChange={setFilter}
            matched={matched}
            total={filterableTotal}
            expandLabel={anyExpanded ? t('folder.collapseAll') : t('folder.expandAll')}
            onToggleExpand={() => (anyExpanded ? collapseAll() : expandAll([...expanded, ...allFolderPaths]))}
            showExpand={allFolderPaths.length > 0}
          />
          {/* `relative` establishes a positioning context for this scroll pane.
              Without it, the absolutely-positioned `sr-only` status spans inside
              the rows (e.g. the "syncing"/"preparing" spinner text) have no
              positioned ancestor and anchor to the initial containing block
              (<html>), so the pane's overflow can't clip them: a row scrolled
              below the fold lands its 1px sr-only span past the viewport bottom
              and grows the *document* — an OS scrollbar that flickered as rows
              entered/left transfer states during a download. Containing them
              here keeps the document pinned to the viewport. */}
          <div
            ref={filesRef}
            /* A scroll pane clips both axes, and the rows sit flush against it, so a focused row
               lost its ring on all four sides. The 4px of interior room is cancelled by an equal
               negative margin: the clip box grows, the rows do not move, so nothing has to be
               re-aligned against the tiles on the right. `pr-4` is the scrollbar gutter (see
               design.md §4) — the same 16px the tiles column uses, so both bars sit off their
               content by an equal margin. */
            className={`relative flex-1 overflow-y-auto scrollbar-thin min-h-0 -mx-1 -mt-1 pl-1 pt-1 pb-4${filesOverflow ? ' pr-4' : ' pr-1'}`}
          >
            {loading ? (
              <LoadingFiles label={t('folder.loading')} />
            ) : error ? (
              <div role="alert" className="bg-surface-container-lowest rounded-xl p-12 flex flex-col items-center justify-center text-center">
                <div className="flex items-center gap-3 mb-3">
                  <Icon name="warning" size={32} className="text-error" />
                  <h2 className="text-2xl font-headline font-bold text-accent">{t('folder.unavailable')}</h2>
                </div>
                <p className="text-on-surface-variant max-w-md leading-relaxed">{error}</p>
              </div>
            ) : files.length === 0 ? (
              <div className="bg-surface-container-lowest rounded-xl p-12 flex flex-col items-center justify-center text-center">
                <h2 className="text-2xl font-headline font-bold text-accent mb-3">
                  {sourceMissing ? t('share.mountPointGone') : t('folder.empty')}
                </h2>
                <p className="text-on-surface-variant max-w-md leading-relaxed">
                  {sourceMissing
                    ? t('folder.emptyHintMissing')
                    : isYou
                      ? t('folder.emptyHintMine')
                      : owner && owner.online === false
                        ? t('folder.emptyHintOfflineOwner', { owner: owner.displayName })
                        : t('folder.emptyHintOther', { owner: owner?.displayName ?? '?' })}
                </p>
              </div>
            ) : visibleTree.length === 0 ? (
              <div className="bg-surface-container-lowest rounded-xl p-12 flex flex-col items-center justify-center text-center">
                <h2 className="text-2xl font-headline font-bold text-accent mb-3">
                  {t('folder.filterEmptyTitle', { term: deferredFilter.trim() })}
                </h2>
                <p className="text-on-surface-variant max-w-md leading-relaxed">
                  {t('folder.filterEmptyHint', { count: filterableTotal })}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <FolderTree
                  nodes={visibleTree}
                  isExpanded={isExpanded}
                  onToggle={toggle}
                  isOwn={isYou}
                  manualControls={manualControls}
                  spaceId={spaceId}
                  members={members}
                  getDownloadSummary={getDownloadSummary}
                  onDownload={downloadFile}
                  onReveal={revealFile}
                  onPause={pauseDownload}
                  onCancel={cancelDownload}
                  onDiscardPartial={discardPartial}
                />
              </div>
            )}
          </div>
        </div>

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
            roleDescription={t(share.role === 'browse'
              ? 'folder.browseDescription'
              : share.role === 'mirrored' ? 'folder.mirroredDescription' : 'folder.mineDescription')}
          />
          {info && (
            <FolderStatsCard
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
        mountPath={null}
        onClose={() => setShowDelete(false)}
        onDelete={async () => {
          await handleDelete()
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
          onRename={handleRename}
          onRelocate={handleRelocate}
          onClose={() => setShowEdit(false)}
        />
      )}
    </div>
  )
}
