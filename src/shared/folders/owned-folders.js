// Owner side of folder sharing: keeps a mounted disk folder (an "owned folder") published into
// its share's catalog. Every producer — mount, relocate, boot, the watcher, the catch-up and the
// periodic reconcile — computes a diff and enqueues work items; one bounded scheduler executes
// them per space. A missing mount root always pauses publishing instead of tombstoning the catalog.
import fs from 'bare-fs'
import path from 'bare-path'
import { ignorePathsFor, clearShareGuards } from './echo-guard.js'
import { getOwnedMount, touchOwnedMountScan, findOwnedMountByShareId } from './mount-store.js'
import { AppError, ErrorCodes } from '../core/errors.js'
import { createLogger } from '../core/logger.js'
import { createCoalescingRunner } from '../core/coalescing-runner.js'
import { getPublishConcurrency, getPublishOrder, getMaxFilesPerShare } from '../core/runtime-config.js'
import { isUnsupportedShare } from '../transfer/content-backends.js'
import { listOwnShare } from '../shares/share-catalog.js'
import { createCatalogBatch } from '../shares/catalog-writer.js'
import { overlayHashFile, setPendingPublishProbe } from '../transfer/backends/overlay/overlay-backend.js'
import { pathFromMount } from '../transfer/path-guard.js'
import { makeKeyedCoalescer } from '../state/coalesce.js'
import { walkDisk } from './walk-disk.js'
import { exceedsShareFileLimit } from './share-limits.js'
import { PREVIEW_DETAIL_MAX_FILES, includePerFile } from './preview-detail.js'
import { relToDriveKey as relToKey, driveKeyToSegments, shouldIgnore, DEFAULT_IGNORE, isAbsoluteDriveKey } from './path-keys.js'
import { OP, PRIORITY } from './work-item.js'
import { createPublishScheduler } from './publish-scheduler.js'
import { createPublishRunner, mountRootAvailable } from './publish-runner.js'

export { shouldIgnore, DEFAULT_IGNORE, mountRootAvailable }

const log = createLogger('owned-folders')

let ipcRef = null
// Injected by the worker: maps a scan outcome onto the mount's durable status and the live UI
// event. Unset outside the worker (integration helpers).
let settleScanRef = null

const reconcileTimers = new Map()
const POST_EVENT_RECONCILE_MS = 2000
// Longer than chokidar's awaitWriteFinish stabilityThreshold, so a catch-up diff that runs
// mid-copy leaves the file to the watcher instead of reading it and reverting.
const SCAN_SETTLE_MS = 2000

const shareCache = new Map()
// Bulk publishes write through one catalog batch per space (few atomic heads for the consumer).
// A batch being closed stays tracked in `settling` until its last flush lands, so a diff or a
// resolving scan never reads the catalog ahead of writes it depends on.
const batches = new Map()
const settling = new Map()

function catalogFor(spaceId) {
  let batch = batches.get(spaceId)
  if (!batch) batches.set(spaceId, (batch = createCatalogBatch(spaceId)))
  return batch
}

function closeBatch(spaceId) {
  const batch = batches.get(spaceId)
  if (!batch) return Promise.resolve()
  batches.delete(spaceId)
  const prev = settling.get(spaceId) ?? Promise.resolve()
  const closed = prev.then(() => batch.close()).catch((err) => log.warn('catalog batch close failed:', err.message))
  settling.set(spaceId, closed)
  closed.then(() => { if (settling.get(spaceId) === closed) settling.delete(spaceId) })
  return closed
}

async function settleCatalog(spaceId) {
  await settling.get(spaceId)
  await batches.get(spaceId)?.flush()
}

async function loadShareForMount(mount) {
  const { readOwnShares } = await import('../shares/shares.js')
  const own = await readOwnShares(mount.spaceId)
  const share = own.find((s) => s.id === mount.shareId)
  if (!share) throw new AppError(ErrorCodes.NOT_FOUND, 'Share missing for mount')
  return { ...share, spaceId: mount.spaceId }
}

async function loadShare(spaceId, shareId) {
  const key = spaceId + '\0' + shareId
  let share = shareCache.get(key)
  if (share) return share
  try {
    share = await loadShareForMount({ spaceId, shareId })
  } catch {
    return null
  }
  shareCache.set(key, share)
  return share
}

const progress = makeKeyedCoalescer((spaceId, shareId) => {
  ipcRef?.emit('event:owned-folder-index-progress', { spaceId, shareId, ...scheduler.statusFor(spaceId, shareId) })
}, { intervalMs: 500, keyOf: (spaceId, shareId) => spaceId + '|' + shareId })

const scheduler = createPublishScheduler({
  execute: createPublishRunner({ loadShare, catalogFor }),
  concurrency: getPublishConcurrency,
  order: getPublishOrder,
  log,
  onProgress: (spaceId, shareId) => progress.poke(spaceId, shareId),
  onShareDrained: (spaceId, shareId) => {
    progress.flush(spaceId, shareId)
    settleCatalog(spaceId).then(() => ipcRef?.emit('event:share-files-updated', { spaceId, shareId }))
  },
  onSpaceIdle: (spaceId) => {
    closeBatch(spaceId)
    for (const key of [...shareCache.keys()]) if (key.startsWith(spaceId + '\0')) shareCache.delete(key)
  },
})

export function initOwnedFolders(_ipc, { settleScan = null } = {}) {
  ipcRef = _ipc
  settleScanRef = settleScan
  setPendingPublishProbe((spaceId, shareId, relPath) => scheduler.isPending(spaceId, shareId, relPath))
}

// Chokidar can drop `add` events when several files land in a new subfolder at once (macOS
// fsevents coalescing). After watcher activity settles, one catch-up diff publishes stragglers.
function scheduleCatchupReconcile(mount) {
  const key = mount.spaceId + ':' + mount.shareId
  clearTimeout(reconcileTimers.get(key))
  const timer = setTimeout(() => {
    reconcileTimers.delete(key)
    const scan = periodicReconcile(mount.spaceId, mount.shareId, mount.mountPath, mount.ignore || DEFAULT_IGNORE, { deferFresh: true })
    if (settleScanRef) settleScanRef(scan, mount.spaceId, mount.shareId)
    else scan.catch((err) => log.debug('catch-up reconcile failed:', err.message))
  }, POST_EVENT_RECONCILE_MS)
  timer.unref?.()
  reconcileTimers.set(key, timer)
}

function relToDriveKey(relPath) {
  return relToKey(relPath, path.sep)
}

export async function handleFsEventFromMain(event) {
  const mount = await findOwnedMountByShareId(event.shareId)
  if (!mount) {
    log.debug('fs event for unknown share', event.shareId)
    return
  }
  return await onFsEvent(mount.spaceId, event.shareId, event.action, event.relPath, event.absPath)
}

// Resolves once the event's work item has settled (or its rerun, when the item was already
// running), so a caller that awaits it observes the effect.
export async function onFsEvent(spaceId, shareId, action, relPath, absPath) {
  const mount = await getOwnedMount(spaceId, shareId)
  if (!mount) {
    log.debug('fs event for unknown mount', spaceId, shareId)
    return
  }
  scheduleCatchupReconcile(mount)

  const driveRel = relToDriveKey(relPath)
  if (isAbsoluteDriveKey(driveRel)) {
    log.warn('refusing fs event with absolute key:', action, driveRel)
    return
  }
  const guard = ignorePathsFor(shareId)
  if (guard.has(absPath)) {
    guard.delete(absPath)
    return
  }

  let size = 0
  let mtime = 0
  try {
    const st = fs.statSync(absPath)
    size = st.size
    mtime = st.mtimeMs
  } catch {}
  const { settled } = scheduler.enqueue({
    spaceId, shareId, relPath: driveRel, absPath,
    op: action === 'unlink' ? OP.RETIRE : OP.PUBLISH,
    size, mtime, priority: PRIORITY.INTERACTIVE,
  })
  const outcome = await settled
  if (outcome.result?.outcome === 'skipped-root-gone') {
    ipcRef?.emit('event:owned-folder-mount-status', { spaceId, shareId, status: 'mount-point-gone' })
  }
  return outcome
}

// Guards the diff, not the publish: the diff is stat-only but still O(files), so two must not
// overlap. `deep` is sticky across a fold (it is the only pass that re-hashes size-matching
// files); `deferFresh` is not — an authoritative pass folded in must publish everything it sees.
const runDiff = createCoalescingRunner({
  merge: (queued, next) => ({
    ...next,
    deep: queued.deep || next.deep,
    deferFresh: Boolean(queued.deferFresh && next.deferFresh),
  }),
})

async function reconcileShare(spaceId, shareId, mountPath, ignore, { deep = false, deferFresh = false } = {}) {
  return await runDiff(spaceId + ':' + shareId, { mountPath, ignore, deep, deferFresh },
    (opts) => diffAndEnqueue(spaceId, shareId, opts))
}

// Size+mtime is the "unchanged" signal. A deep pass distrusts mtimes (a relocated tree has fresh
// ones everywhere) and enqueues regardless; the publish then settles equality by hash. A catch-up
// pass leaves a fresh, never-published file to the watcher's awaitWriteFinish instead of reading
// it mid-copy; `age >= 0` keeps a future mtime (clock skew) from deferring it forever.
function needsPublish(prev, info, deep, deferFresh) {
  if (deep) return true
  if (prev && prev.size === info.size && prev.mtime === info.mtime && prev.contentHash) return false
  if (deferFresh && !prev) {
    const age = Date.now() - info.mtime
    if (age >= 0 && age < SCAN_SETTLE_MS) return false
  }
  return true
}

async function diffAndEnqueue(spaceId, shareId, { mountPath, ignore, deep, deferFresh }) {
  const mount = await getOwnedMount(spaceId, shareId)
  if (!mount) throw new AppError(ErrorCodes.NOT_FOUND, 'Mount missing')
  const share = await loadShareForMount(mount)

  // A missing root is ambiguous (transient vs. permanent) and guessing "deleted" would enqueue a
  // retire for every file in the share. Bail without touching the catalog or the queue; the probe
  // loop restarts us when the path returns.
  if (!mountRootAvailable(mountPath)) {
    log.warn('mount path unavailable, skipping reconcile:', mountPath)
    ipcRef?.emit('event:owned-folder-mount-status', { spaceId, shareId, status: 'mount-point-gone' })
    return { skipped: 'mount-point-gone', totalOnDisk: 0 }
  }
  if (isUnsupportedShare(share)) {
    log.warn('skipping scan for unsupported content mode:', share.contentMode, shareId)
    return { skipped: 'unsupported-content-mode', totalOnDisk: 0 }
  }

  const { onDisk, unreadable } = await walkDisk(mountPath, ignore)
  // Commit the space batch first, or this read misses every hash materialized in the last flush
  // window and re-enqueues those files.
  await settleCatalog(spaceId)
  const known = new Map()
  for await (const entry of listOwnShare(spaceId, shareId)) known.set(entry.relPath, entry)

  scheduler.beginShare(spaceId, shareId, onDisk.size)
  const specs = []
  for (const [relPath, info] of onDisk) {
    if (!needsPublish(known.get(relPath), info, deep, deferFresh)) continue
    specs.push({
      spaceId, shareId, relPath, absPath: pathFromMount(mountPath, relPath),
      op: OP.PUBLISH, size: info.size, mtime: info.mtime, deep, priority: PRIORITY.BULK,
    })
  }
  for (const [relPath, entry] of known) {
    if (onDisk.has(relPath) || unreadable.has(relPath)) continue
    specs.push({
      spaceId, shareId, relPath, absPath: pathFromMount(mountPath, relPath),
      op: OP.RETIRE, size: entry.size || 0, priority: PRIORITY.BULK,
    })
  }
  scheduler.enqueueMany(specs)
  await touchOwnedMountScan(spaceId, shareId)
  return { enqueued: specs.length, totalOnDisk: onDisk.size }
}

// Resolves after this pass's items have settled with { uploaded, deleted, totalOnDisk }, or with
// { skipped } when the diff could not run.
export async function initialPublishScan(spaceId, shareId, mountPath, ignore, opts = {}) {
  const r = await reconcileShare(spaceId, shareId, mountPath, ignore, opts)
  if (r.skipped) return { skipped: r.skipped, uploaded: 0, deleted: 0, totalOnDisk: 0 }
  const t = await scheduler.whenDrained(spaceId, shareId)
  await settleCatalog(spaceId)
  return { uploaded: t?.uploaded ?? 0, deleted: t?.deleted ?? 0, failed: t?.failed ?? 0, totalOnDisk: r.totalOnDisk }
}

export const periodicReconcile = initialPublishScan

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

export function getIndexStatus(spaceId, shareId) {
  return scheduler.statusFor(spaceId, shareId)
}

export function cancelIndex(spaceId, shareId) {
  return scheduler.cancelShare(spaceId, shareId)
}

export function stopOwnedFolder(spaceId, shareId) {
  const key = spaceId + ':' + shareId
  clearTimeout(reconcileTimers.get(key))
  reconcileTimers.delete(key)
  clearShareGuards(shareId)
  scheduler.cancelShare(spaceId, shareId)
}

export async function stopPublishingForSpace(spaceId) {
  await scheduler.cancelSpace(spaceId)
  await closeBatch(spaceId)
}

export function stopAllPublishing() {
  scheduler.stop()
}

export function _resetOwnedFolders() {
  for (const timer of reconcileTimers.values()) clearTimeout(timer)
  reconcileTimers.clear()
  scheduler._reset()
  progress.reset()
  shareCache.clear()
  for (const batch of batches.values()) batch.close().catch(() => {})
  batches.clear()
  settling.clear()
}

export { walkDisk }
