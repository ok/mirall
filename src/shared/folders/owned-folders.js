// Owner side of folder sharing: keeps a mounted disk folder (an "owned folder")
// published into its share's catalog. Live watcher events (chokidar, forwarded from
// Electron main) publish per-file adds/deletes; a trailing catch-up reconcile plus
// the periodic scan heal missed events by diffing the disk against the catalog. A
// missing mount root always pauses publishing instead of tombstoning the catalog.
import fs from 'bare-fs'
import path from 'bare-path'
import { ignorePathsFor, clearShareGuards } from './echo-guard.js'
import { getOwnedMount, touchOwnedMountScan, findOwnedMountByShareId } from './mount-store.js'
import { AppError, ErrorCodes } from '../core/errors.js'
import { createLogger } from '../core/logger.js'
import { getContentBackend, isUnsupportedShare } from '../transfer/content-backends.js'
import { listOwnShare } from '../shares/share-catalog.js'
import { overlayHashFile } from '../transfer/backends/overlay/overlay-backend.js'
import { walkDisk } from './walk-disk.js'
import { exceedsShareFileLimit } from './share-limits.js'
import { getMaxFilesPerShare } from '../core/runtime-config.js'
import { PREVIEW_DETAIL_MAX_FILES, includePerFile } from './preview-detail.js'
import { relToDriveKey as relToKey, driveKeyToSegments, shouldIgnore, DEFAULT_IGNORE, isAbsoluteDriveKey } from './path-keys.js'

// Re-exported so existing import sites (`foreign-folders.js`, `worker/main.js`,
// `test/integration/ignore-matchers.test.js`) keep their `./owned-folders.js`
// import path; the implementations now live in the pure `path-keys.js`.
export { shouldIgnore, DEFAULT_IGNORE }

const log = createLogger('owned-folders')

let ipcRef = null
// Injected by the worker: maps a scan/reconcile outcome onto the mount's durable status, the
// live UI event, and (for a missing root) the watcher/timer teardown. This module reports
// outcomes; the policy for acting on one belongs to the process that owns the watcher and the
// mount-point probe. Unset outside the worker (integration helpers), which keeps the old
// fire-and-forget behaviour.
let settleScanRef = null

const reconcileTimers = new Map()
const POST_EVENT_RECONCILE_MS = 2000

export function initOwnedFolders(_ipc, { settleScan = null } = {}) {
  ipcRef = _ipc
  settleScanRef = settleScan
}

// Chokidar can drop `add` events when several files land in a new subfolder at
// once (macOS fsevents coalescing), leaving a copied file unpublished. After
// watcher activity settles, run one catch-up reconcile (trailing debounce) so a
// full disk diff publishes any stragglers the per-file events missed.
function scheduleCatchupReconcile(mount) {
  const key = mount.spaceId + ':' + mount.shareId
  clearTimeout(reconcileTimers.get(key))
  const timer = setTimeout(() => {
    reconcileTimers.delete(key)
    const scan = periodicReconcile(mount.spaceId, mount.shareId, mount.mountPath, mount.ignore || DEFAULT_IGNORE)
    // Settle the OUTCOME rather than swallowing it. This reconcile is the fastest signal that a
    // vanished source is back — or still gone — and running it silently repaired the catalog while
    // leaving the durable status (and the "source missing" banner) latched on the last bad value.
    if (settleScanRef) settleScanRef(scan, mount.spaceId, mount.shareId)
    else scan.catch((err) => log.debug('catch-up reconcile failed:', err.message))
  }, POST_EVENT_RECONCILE_MS)
  timer.unref?.()
  reconcileTimers.set(key, timer)
}

function relToDriveKey(relPath) {
  return relToKey(relPath, path.sep)
}

export function mountRootAvailable(mountPath) {
  try {
    return fs.statSync(mountPath).isDirectory()
  } catch {
    return false
  }
}

async function loadShareForMount(mount) {
  const { readOwnShares } = await import('../shares/shares.js')
  const own = await readOwnShares(mount.spaceId)
  const share = own.find((s) => s.id === mount.shareId)
  if (!share) throw new AppError(ErrorCodes.NOT_FOUND, 'Share missing for mount')
  return { ...share, spaceId: mount.spaceId }
}

export async function handleFsEventFromMain(event) {
  const mount = await findOwnedMountByShareId(event.shareId)
  if (!mount) {
    log.debug('fs event for unknown share', event.shareId)
    return
  }
  return await onFsEvent(mount.spaceId, event.shareId, event.action, event.relPath, event.absPath)
}

export async function onFsEvent(spaceId, shareId, action, relPath, absPath) {
  const mount = await getOwnedMount(spaceId, shareId)
  if (!mount) {
    log.debug('fs event for unknown mount', spaceId, shareId)
    return
  }
  scheduleCatchupReconcile(mount)

  const share = await loadShareForMount(mount)

  const driveRel = relToDriveKey(relPath)
  // Last line of defence (mirrors the walkDisk guard): a live watcher event must
  // never publish an absolute key — catalog keys are always share-relative (e.g. a
  // Windows `\\?\…` extended-length path slipping through unstripped would arrive
  // absolute). relPath should already be share-relative, but refuse anything that
  // isn't rather than poison the share.
  if (isAbsoluteDriveKey(driveRel)) {
    log.warn('refusing fs event with absolute key:', action, driveRel)
    return
  }
  const guard = ignorePathsFor(shareId)
  if (guard.has(absPath)) {
    guard.delete(absPath)
    return
  }

  // An own share whose content mode this build can't serve (overlay flag turned
  // off after creation) must not publish — render it unavailable until the mode
  // is supported again.
  if (isUnsupportedShare(share)) {
    log.warn('ignoring fs-event for unsupported content mode:', share.contentMode, shareId)
    return
  }
  const backend = getContentBackend(share)   // always overlay
  if (action === 'unlink') {
    if (!mountRootAvailable(mount.mountPath)) {
      ipcRef?.emit('event:owned-folder-mount-status', { spaceId, shareId, status: 'mount-point-gone' })
      return
    }
    // Editors save via rename-over / delete+recreate, which fires a raw unlink for
    // a path that's immediately back on disk — re-check existence before propagating.
    if (fs.existsSync(absPath)) return
    await backend.publishDelete(spaceId, share, driveRel)
    return
  }
  await backend.publishAdd(spaceId, share, driveRel, absPath)
}

export async function initialPublishScan(spaceId, shareId, mountPath, ignore, { deep = false } = {}) {
  const mount = await getOwnedMount(spaceId, shareId)
  if (!mount) throw new AppError(ErrorCodes.NOT_FOUND, 'Mount missing')
  const share = await loadShareForMount(mount)

  // The source folder may have been moved, renamed, or be on a disconnected
  // drive. A missing root is ambiguous (transient vs. permanent), and guessing
  // "deleted" is catastrophic — the scan would tombstone every catalog entry,
  // cascading deletions to every mirror peer. Bail out without touching the
  // catalog; peers keep the last-known contents, and the probe loop restarts us
  // when the path returns.
  if (!mountRootAvailable(mountPath)) {
    log.warn('mount path unavailable, skipping reconcile:', mountPath)
    ipcRef?.emit('event:owned-folder-mount-status', { spaceId, shareId, status: 'mount-point-gone' })
    return { skipped: 'mount-point-gone', uploaded: 0, deleted: 0, totalOnDisk: 0 }
  }

  // An own share whose content mode this build can't serve must not be scanned.
  if (isUnsupportedShare(share)) {
    log.warn('skipping scan for unsupported content mode:', share.contentMode, shareId)
    return { skipped: 'unsupported-content-mode', uploaded: 0, deleted: 0, totalOnDisk: 0 }
  }
  const backend = getContentBackend(share)   // always overlay
  const result = await backend.scan(spaceId, share, mountPath, ignore, { deep })
  await touchOwnedMountScan(spaceId, shareId)
  return result
}

export async function previewInitialPublishScan(spaceId, shareId, mountPath, ignore, opts = {}) {
  // Catalog side only matters when re-previewing an existing share (relocate). The
  // Add-Folder UI passes shareId=null → onCatalog empty → a pure stat-only walk.
  const onCatalog = new Map()
  if (shareId) {
    for await (const entry of listOwnShare(spaceId, shareId)) onCatalog.set(entry.relPath, entry)
  }

  const { onDisk } = await walkDisk(mountPath, ignore, { onProgress: opts.onProgress, signal: opts.signal })

  let toUpload = 0
  let conflicts = 0
  let totalBytes = 0
  const candidates = []
  for (const [relPath, info] of onDisk) {
    const existing = onCatalog.get(relPath)
    let conflict = false
    if (existing) {
      if (existing.size === info.size && existing.mtime === info.mtime) continue
      if (existing.size !== info.size) {
        conflict = true
      } else {
        // Same size, different mtime: only a content hash can tell a real edit
        // from a touch. Compare with the overlay hasher (catalog hashes are
        // leaf/size-prefixed, not plain blake2b).
        const abs = path.join(mountPath, ...driveKeyToSegments(relPath))
        let diskHash = null
        try { diskHash = await overlayHashFile(abs) } catch { diskHash = null }
        if (diskHash != null && existing.contentHash != null && existing.contentHash === diskHash) continue
        conflict = true
      }
      conflicts += 1
    }
    toUpload += 1
    totalBytes += info.size
    if (candidates.length <= PREVIEW_DETAIL_MAX_FILES) candidates.push({ relPath, size: info.size, conflict })
  }

  const detailed = includePerFile(toUpload)
  // The limit is about how many files the folder HOLDS, not how many this scan would upload —
  // a re-preview of an existing share uploads only the changed ones.
  const totalFiles = onDisk.size
  return {
    flow: 'add-owned-folder',
    toUpload,
    toDownload: 0,
    conflicts,
    existingAtDestination: onDisk.size,
    totalBytes,
    perFile: detailed ? candidates : [],
    perFileOmitted: !detailed,
    totalFiles,
    fileLimit: getMaxFilesPerShare(),
    overFileLimit: exceedsShareFileLimit(totalFiles),
  }
}

// The count the worker's admission gate reads. Stat-only, and it walks the same way the publish
// scan does, so the gate can never admit a folder the scan would then find too large.
export async function countFolderFiles(mountPath, ignore) {
  const { onDisk } = await walkDisk(mountPath, ignore)
  return onDisk.size
}

export async function periodicReconcile(spaceId, shareId, mountPath, ignore, opts) {
  // Forward opts ({ deep }) — the scheduler runs every Nth pass deep (content-hash)
  // to catch an in-place rewrite that kept identical size + mtime.
  return await initialPublishScan(spaceId, shareId, mountPath, ignore, opts)
}

export function stopOwnedFolder(spaceId, shareId) {
  const key = spaceId + ':' + shareId
  clearTimeout(reconcileTimers.get(key))
  reconcileTimers.delete(key)
  clearShareGuards(shareId)
}

export { walkDisk }
