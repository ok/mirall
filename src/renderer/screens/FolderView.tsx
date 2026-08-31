// Folder-share screen: the share's file listing as a collapsible folder tree with
// per-file transfer status/progress, mirror controls, and who-is-downloading indicators.
import { useState, useEffect, useMemo, useRef } from 'react'
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
import Avatar, { type AvatarSize } from '../components/primitives/Avatar.js'
import FolderTree from '../components/widgets/FolderTree.js'
import LoadingFiles from '../components/widgets/LoadingFiles.js'
import DeleteFolderShareModal from '../components/modals/DeleteFolderShareModal.js'
import MirroredByWidget from '../components/cards/MirroredByWidget.js'
import { formatSize } from '../utils.js'
import { buildFileTree, collectFolderPaths, topLevelFolderPaths } from '../fileTree.js'
import { request } from '../ipc.js'
import { setForeignMountEnabled, unmountForeignMount, useForeignMount } from '../hooks/useForeignMount.js'
import { useOwnedMount } from '../hooks/useFolderMount.js'
import { useIndexProgress } from '../hooks/useIndexProgress.js'
import { deriveIndexSummary } from '../indexSummary.js'
import { useHasVerticalOverflow } from '../hooks/useHasVerticalOverflow.js'
import { useToast } from '../components/toast/useToast.js'
import type { ShareWithRole } from '../hooks/useShares.js'
import type { Profile, SpaceMember, FileTreeNode } from '../types.js'

interface FolderViewProps {
  spaceId: string
  share: ShareWithRole
  onBack: () => void
  onMirror?: (share: ShareWithRole) => void
  onUnmounted?: () => void
}

function resolveOwner(owner: SpaceMember | null, isYou: boolean, selfProfile: Profile | null) {
  if (isYou && selfProfile) return { avatar: selfProfile.avatar, displayName: selfProfile.displayName }
  if (owner) return { avatar: owner.avatar ?? null, displayName: owner.displayName }
  return { avatar: null as string | null, displayName: null as string | null }
}

function OwnerHeaderAvatar({ owner, isYou, selfProfile, size }: { owner: SpaceMember | null; isYou: boolean; selfProfile: Profile | null; size: AvatarSize | number }) {
  const resolved = resolveOwner(owner, isYou, selfProfile)
  return <Avatar src={resolved.avatar} displayName={resolved.displayName} size={size} />
}

export default function FolderView({ spaceId, share, onBack, onMirror, onUnmounted }: FolderViewProps) {
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

  // The tree is derived from the flat file list; expansion state is separate and keyed by
  // stable folder paths, so it survives every rebuild (incl. live progress ticks).
  const tree = useMemo<FileTreeNode[]>(() => buildFileTree(files), [files])
  const { isExpanded, toggle, expandAll, collapseAll, hasStored } = useTreeExpansion(share.id)
  const allFolderPaths = useMemo<string[]>(() => collectFolderPaths(tree), [tree])
  const anyExpanded = allFolderPaths.some(isExpanded)
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
  const { status: ownedStatus } = useOwnedMount(spaceId, isYou ? share.id : '')
  // The scan's queue depth, which the file rows cannot show: a queued file has no catalog entry
  // yet, so it has no row. Ours reports locally; a peer's is re-announced by its owner, so it is
  // only meaningful while they are reachable — an owner that drops mid-scan sends no final frame.
  const indexingStatus = useIndexProgress(spaceId, share.id, isYou)
  const indexing = deriveIndexSummary(isYou || owner?.online !== false ? indexingStatus : null)
  const sourceMissing = isYou && (ownedStatus ?? share.mountStatus) === 'mount-point-gone'

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

  async function handlePauseResume() {
    try {
      await setForeignMountEnabled(spaceId, share.id, !foreignEnabled)
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

  const mirroredMenuItems: ActionMenuItemConfig[] = [
    foreignEnabled
      ? { id: 'pause', label: t('share.pauseMirror'), icon: 'pause', onAction: handlePauseResume }
      : { id: 'resume', label: t('share.resumeMirror'), icon: 'play_arrow', onAction: handlePauseResume },
    { id: 'unmount', label: t('share.unmountMirror'), icon: 'close', variant: 'danger', onAction: handleUnmount },
  ]

  return (
    <div className="max-w-7xl mx-auto px-8 flex flex-col h-[calc(100vh-5rem-var(--banner-h,0px))]">
      <div className="shrink-0 pt-8 pb-4">
        <div className="flex items-start gap-4 mb-2">
          <IconButton
            icon="arrow_back"
            onClick={onBack}
            ariaLabel={t('actions.back')}
            className="mt-1 shrink-0"
          />
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <OwnerHeaderAvatar owner={owner} isYou={isYou} selfProfile={profile} size={52} />
            <div className="min-w-0">
              <h1 className="text-4xl font-headline font-extrabold text-accent tracking-tighter leading-tight truncate pb-1.5">
                {share.name}
              </h1>
              <p className="text-xs font-bold text-secondary tracking-wide uppercase mt-1 flex items-center gap-1.5 flex-wrap">
                <span>
                  {isYou
                    ? t('share.sharedByYou')
                    : t('share.ownedBy', { name: owner?.displayName ?? '?' })}
                  {space ? ' · ' + t('space.in', { name: space.name }) : null}
                  {share.role === 'mirrored'
                    ? ' · ' + t('share.badgeMirrored') + ' · ' + (foreignEnabled ? t('share.readOnly') : t('folder.paused'))
                    : null}
                </span>
                {share.role === 'mirrored' && (
                  <button
                    type="button"
                    title={t('folder.mirroredDescription')}
                    aria-label={t('folder.mirroredDescription')}
                    className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-surface-container-highest text-accent hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
                  >
                    <Icon name="info" size={10} />
                  </button>
                )}
              </p>
            </div>
          </div>
          <div className="flex gap-3 mt-2 shrink-0">
            {share.role === 'browse' && onMirror && (
              <Button icon="folder_download" onClick={() => onMirror(share)}>
                {t('share.mirrorToDisk')}
              </Button>
            )}

            {share.role === 'mirrored' && (
              <>
                <Button icon="folder_open" onClick={handleRevealFolder}>
                  {t('share.openInFinder')}
                </Button>
                <ActionMenu
                  label={t('share.moreActions')}
                  items={mirroredMenuItems}
                  ariaLabel={t('share.moreActions')}
                />
              </>
            )}

            {share.role === 'mine' && (
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
                <Button variant="danger" icon="delete" onClick={() => setShowDelete(true)}>
                  {t('share.deleteFolder')}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-hidden grid grid-cols-1 min-[900px]:grid-cols-[1fr_300px] gap-8 pt-4 pb-8">
        <div className="overflow-hidden flex flex-col min-h-0">
          <div className="flex items-center justify-between gap-3 mb-4 shrink-0 flex-wrap">
            <div className="flex items-baseline gap-3">
              <h2 className="text-2xl font-headline font-bold text-accent">
                {t('folder.filesInFolder')}
              </h2>
              {info && (
                <span className="text-sm font-label text-secondary font-bold">
                  {t('folder.fileCountAndSize', { count: info.fileCount, size: formatSize(info.totalBytes) })}
                </span>
              )}
            </div>
            {allFolderPaths.length > 0 && (
              <Button
                variant="secondary"
                onClick={() => (anyExpanded ? collapseAll() : expandAll(allFolderPaths))}
              >
                {anyExpanded ? t('folder.collapseAll') : t('folder.expandAll')}
              </Button>
            )}
          </div>
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
            className={`relative flex-1 overflow-y-auto scrollbar-thin min-h-0 pb-4${filesOverflow ? ' pr-4' : ''}`}
          >
            {share.role === 'mirrored' && !foreignEnabled && !loading && (
              <div role="status" className="flex items-center gap-2 mb-4 px-4 py-2 rounded-lg bg-warning/20 text-on-surface text-sm">
                <Icon name="pause" size={16} className="text-warning shrink-0" />
                <span>{t('folder.mirrorPausedBanner')}</span>
              </div>
            )}
            {!isYou && owner && owner.online === false && !loading && !error && (
              <div role="status" className="flex items-center gap-2 mb-4 px-4 py-2 rounded-lg bg-surface-container-low text-on-surface-variant text-sm">
                <Icon name="cloud" size={16} className="text-on-surface-variant shrink-0" />
                <span>{t('folder.offlineBanner', { owner: owner.displayName })}</span>
              </div>
            )}
            {sourceMissing && !loading && (
              <div role="alert" className="flex items-center gap-2 mb-4 px-4 py-2 rounded-lg bg-error-container text-on-error-container text-sm">
                <Icon name="warning" size={16} className="shrink-0" />
                <span>{t('folder.sourceMissingBanner')}</span>
              </div>
            )}
            {/* Always-present live region so the scan notice is ANNOUNCED when it appears — same
                reason as the over-limit region below. Counts the SCAN (scheduler queue depth), not
                the rows on screen: FolderTree's "N adding" badge counts rows, and a file that is
                only queued has no row yet, which is exactly the gap this closes. */}
            {indexing.active && (
              <div className="flex items-center gap-2 mb-4 px-4 py-2 rounded-lg bg-info/20 text-on-surface text-sm">
                <Icon name="update" size={16} className="text-on-info shrink-0 animate-pulse" />
                <span>
                  {isYou
                    ? t('folder.indexingSummary', { count: indexing.files })
                    : t('folder.indexingSummaryPeer', { count: indexing.files, owner: owner?.displayName ?? '' })}
                  {indexing.bytesQueued > 0 ? ' · ' + t('folder.indexingQueuedSize', { size: formatSize(indexing.bytesQueued) }) : ''}
                </span>
              </div>
            )}
            {/* The counts above change about twice a second for the length of the scan, so they are
                deliberately NOT in a live region — ProgressBar makes the same call for the same
                reason. This one carries a count-free sentence, so it is announced once when the
                scan starts and once when it ends, while the numbers stay browsable as text. */}
            <div role="status" aria-live="polite" className="sr-only">
              {indexing.active
                ? (isYou ? t('folder.indexingAnnounce') : t('folder.indexingAnnouncePeer', { owner: owner?.displayName ?? '' }))
                : ''}
            </div>
            {/* Always-present live region so the "first N of M" notice is ANNOUNCED when it
                appears — a role=status region added to the DOM already-populated is not
                reliably announced by screen readers, so it must pre-exist (empty) and update. */}
            <div
              role="status"
              aria-live="polite"
              className={listingTruncated ? 'flex items-center gap-2 mb-4 px-4 py-2 rounded-lg bg-surface-container-low text-on-surface-variant text-sm' : 'sr-only'}
            >
              {listingTruncated && info ? (
                <>
                  <Icon name="folder" size={16} className="text-on-surface-variant shrink-0" />
                  <span>{t('folder.overLimitListing', { shown: files.length, total: info.fileCount, limit: info.fileLimit ?? files.length })}</span>
                </>
              ) : null}
            </div>
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
            ) : (
              <div className="space-y-2">
                <FolderTree
                  nodes={tree}
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

        <div className="space-y-6 min-h-0 overflow-hidden pt-12">
          <div className="bg-surface-container-low rounded-2xl p-6">
            <div className="flex items-center gap-3 mb-3">
              <OwnerHeaderAvatar owner={owner} isYou={isYou} selfProfile={profile} size="md" />
              <div className="min-w-0">
                <p className="font-bold text-accent">
                  {isYou ? t('share.sharedByYou') : owner?.displayName ?? '?'}
                </p>
                {!isYou && (
                  <p className="text-xs text-on-surface-variant">
                    {owner?.online !== false ? t('member.online') : t('member.offline')}
                  </p>
                )}
              </div>
            </div>
            <p className="text-xs text-on-surface-variant leading-relaxed">
              {share.role === 'browse'
                ? t('folder.browseDescription')
                : share.role === 'mirrored'
                  ? t('folder.mirroredDescription')
                  : t('folder.mineDescription')}
            </p>
          </div>

          {isYou && <MirroredByWidget spaceId={spaceId} shareId={share.id} members={members} />}

          {info && (
            <div className="bg-surface-container-low p-8 rounded-2xl">
              <h3 className="text-xl font-headline font-bold text-accent mb-6 flex items-center gap-2">
                <Icon name="folder" className="text-secondary" />
                {t('folder.folderSize')}
              </h3>
              <div className="text-5xl font-headline font-extrabold text-accent tracking-tighter leading-none">
                {formatSize(info.totalBytes)}
              </div>
              <p className="mt-2 text-sm font-medium text-on-surface-variant">
                {t('folder.fileCount', { count: info.fileCount })}
              </p>
            </div>
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
    </div>
  )
}
