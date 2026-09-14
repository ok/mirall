import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useOwnedMount } from './useFolderMount.js'
import { useIndexProgress } from './useIndexProgress.js'
import { deriveIndexSummary } from '../indexSummary.js'
import { deriveMirrorSync } from '../mirrorSync.js'
import { deriveStrips } from '../folderStrips.js'
import { deriveFolderStatus } from '../folderStatus.js'
import { mountFault } from '../../shared/contract/mount-fault.js'
import { rowBytesOnDevice } from '../rowView.js'
import { useShareFiles } from './useShareFiles.js'
import { useForeignMount } from './useForeignMount.js'
import type { ShareWithRole } from './useShares.js'
import type { SpaceMember, Profile } from '../types.js'
import type { TFunction } from 'i18next'

type Strip = ReturnType<typeof deriveStrips>[number]

// Derived from the producers rather than restated: `files`/`info` are exactly what useShareFiles
// returns, `foreignMount` what useForeignMount returns, `owner` a roster row. A hand-written copy
// of any of these is a second contract to keep in step.
type ShareFilesResult = ReturnType<typeof useShareFiles>
type ForeignMountResult = ReturnType<typeof useForeignMount>

type FolderViewModelInput = {
  spaceId: string
  share: ShareWithRole
  isYou: boolean
  owner: SpaceMember | null | undefined
  profile: Profile | null | undefined
  files: ShareFilesResult['files']
  info: ShareFilesResult['info']
  loading: ShareFilesResult['loading']
  error: ShareFilesResult['error']
  getDecoration: ShareFilesResult['getDecoration']
  listingTruncated: boolean
  foreignMount: ForeignMountResult['mount']
  foreignStatus: ForeignMountResult['status']
}

// One count-free sentence for "work started / work ended", so it is announced twice rather than
// twice a second. It is the ONLY announcement of a working folder: the strip carrying the numbers
// is deliberately not a live region, and the tile does not repeat what the strip says. Derived
// from the strips themselves so the two can never disagree — a paused mirror whose rows have not
// settled yet must not announce that it is syncing.
function announceWork(working: Strip | null, peerWorking: Strip | null, ownerName: string, t: TFunction) {
  if (working?.data?.kind === 'indexing') return t('folder.indexingAnnounce')
  if (working?.data?.kind === 'mirroring') return t('folder.syncingAnnounce', { owner: ownerName })
  if (peerWorking) return t('folder.indexingAnnouncePeer', { owner: ownerName })
  return ''
}

/**
 * The local mount half: which role owns this folder decides which mount hook answers for it, and
 * both roles are read unconditionally because hooks cannot be called in a branch — the one that
 * does not apply is handed an empty id and reports nothing.
 */
function useMountState({ spaceId, share, isYou, owner, foreignMount, foreignStatus }: FolderViewModelInput) {
  // Live while mounted: owned-folder:list-all (a live mountRootAvailable check) re-derives on every
  // mount-status event; the useShares projection covers SpaceView only.
  const { status: ownedStatus, lastError: ownedError, loaded: ownedLoaded, paused: ownedPaused, scanning, mountPath: ownedPath } = useOwnedMount(spaceId, isYou ? share.id : '')
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
    () => deriveIndexSummary(indexProgress, { paused: ownedPaused, scanning }),
    [indexProgress, ownedPaused, scanning],
  )
  // Live read wins once loaded, including "healthy": the hook returns null for a healthy mount, so
  // `??` would resurrect the snapshot.
  const ownedMountStatus = ownedLoaded ? ownedStatus : (share.mountStatus ?? null)
  // The durable local fault, from whichever role owns this folder.
  const fault = useMemo(
    () => (isYou
      ? mountFault(ownedMountStatus, ownedError)
      : mountFault(foreignStatus ?? foreignMount?.status, foreignMount?.lastError)),
    [isYou, ownedMountStatus, ownedError, foreignStatus, foreignMount],
  )
  return {
    ownedPaused,
    ownedPath,
    indexing,
    fault,
    sourceMissing: isYou && ownedMountStatus === 'mount-point-gone',
  }
}

/**
 * How much of a mirror is actually here. Only a mirror can answer honestly: an owner holds every
 * file by definition and a browser holds none, so for those roles the counts are null rather than
 * a number that would read as a claim.
 */
function useMirrorCounts({ share, files, info, listingTruncated, getDecoration }: FolderViewModelInput, foreignEnabled: boolean) {
  const mirrorSync = useMemo(
    () => (share.role === 'mirrored'
      ? deriveMirrorSync(files, {
        truncated: listingTruncated,
        enabled: foreignEnabled,
        bytesOf: (f) => rowBytesOnDevice(f, getDecoration(f.relPath)),
      })
      : null),
    [share.role, files, listingTruncated, foreignEnabled, getDecoration],
  )
  const onDeviceCount = share.role === 'mirrored' && !listingTruncated ? (mirrorSync?.onDevice ?? null) : null
  // Only a gap we can prove. Truncated means onDeviceCount is null (a capped sample), and info may
  // not have loaded; either way we do not know, so the pill does not claim.
  const mirrorIncomplete = onDeviceCount !== null
    && typeof info?.fileCount === 'number'
    && onDeviceCount < info.fileCount
  return { mirrorSync, onDeviceCount, mirrorIncomplete }
}

/**
 * Everything a folder screen shows ABOUT a folder, as opposed to the files in it.
 *
 * Each answer already has a pure module that knows the rule — folderStrips, folderStatus,
 * mirrorSync, indexSummary, mount-fault. What lives here is the wiring those rules need: which
 * role's fault to read, which counts a mirror can report honestly, and the memo boundaries that
 * keep a fresh object per render from invalidating everything downstream of it.
 */
export function useFolderViewModel(input: FolderViewModelInput) {
  const { t } = useTranslation()
  const {
    share, isYou, owner, profile, files, info, loading, error,
    listingTruncated, foreignMount, foreignStatus,
  } = input

  const foreignEnabled = share.role === 'mirrored' && (foreignMount?.enabled ?? true) && foreignStatus !== 'paused'
  const manualControls = share.role === 'browse'
  const { ownedPaused, ownedPath, indexing, fault, sourceMissing } = useMountState(input)
  const { mirrorSync, onDeviceCount, mirrorIncomplete } = useMirrorCounts(input, foreignEnabled)
  // Whose folder this is decides whose name goes on it, and an unnamed peer still needs a word.
  const ownerName = ((isYou ? profile : owner)?.displayName) || t('avatar.unknown')
  // A missing roster row is not an offline owner: absent means unknown, and both the strips and the
  // tile treat unknown as present rather than claiming they are away.
  const ownerOnline = owner?.online !== false

  const strips = useMemo(() => deriveStrips({
    role: share.role,
    isYou,
    loading,
    error: !!error,
    sourceMissing,
    fault,
    indexing,
    foreignEnabled,
    mirrorSync,
    ownerOnline,
    listing: listingTruncated && info
      ? { truncated: true, shown: files.length, total: info.fileCount, limit: info.fileLimit ?? files.length }
      : null,
  }), [share.role, isYou, loading, error, sourceMissing, fault, indexing, foreignEnabled, mirrorSync, ownerOnline, listingTruncated, info, files.length])

  const overLimit = strips.find((strip) => strip.id === 'over-limit') ?? null
  const working = strips.find((strip) => strip.id === 'working') ?? null
  const peerWorking = strips.find((strip) => strip.id === 'peer-indexing') ?? null
  const workAnnouncement = announceWork(working, peerWorking, ownerName, t)

  const folderStatus = deriveFolderStatus({
    role: share.role,
    sourceMissing,
    fault: !!fault,
    paused: ownedPaused,
    mirrorEnabled: foreignEnabled,
    indexing: indexing.active,
    // Same rule the strip applies: with the owner away nothing is being fetched, so the tile must
    // not read "Syncing" beside a strip that says they are offline.
    mirrorSyncing: !!mirrorSync?.active && ownerOnline,
    ownerOnline,
    incomplete: mirrorIncomplete,
  })
  // Only OUR OWN running work gates the destructive entry, and only while it is not paused. A
  // mirror's sync is the owner's doing and can last as long as they keep adding files — disabling
  // Unmount for its duration would leave the user with a dead control while the same action still
  // works from the folder card on the space screen.
  const busy = isYou && indexing.active && !indexing.paused
  const filterableTotal = listingTruncated ? files.length : (info?.fileCount ?? files.length)

  return {
    foreignEnabled, manualControls, ownedPaused, ownedPath, sourceMissing, fault, indexing,
    mirrorSync, ownerName, strips, overLimit, working, peerWorking, workAnnouncement,
    onDeviceCount, mirrorIncomplete, folderStatus, busy, filterableTotal,
  }
}
