// Owner side of folder sharing: keeps a mounted disk folder (an "owned folder") published into
// its share's catalog. Every producer — mount, relocate, boot, the watcher, the catch-up and the
// periodic reconcile — computes a diff and enqueues work items on the shared publish service; the
// folder channel registered here resolves, publishes and retires them. A missing mount root always
// pauses publishing instead of tombstoning the catalog.
import path from 'bare-path'
import { ignorePathsFor, clearShareGuards } from './echo-guard.js'
import { getOwnedMount, touchOwnedMountScan, findOwnedMountByShareId } from './mount-store.js'
import { AppError, ErrorCodes } from '../core/errors.js'
import { createLogger } from '../core/logger.js'
import { Subsystem } from '../core/subsystem.js'
import { createCoalescingRunner } from '../core/coalescing-runner.js'
import { getMaxFilesPerShare } from '../core/runtime-config.js'
import { getContentBackend, isUnsupportedShare } from '../transfer/content-backends.js'
import { listOwnShare } from '../shares/share-catalog.js'
import { overlayHashFile, ensureServable, setPendingPublishProbe } from '../transfer/backends/overlay/overlay-backend.js'
import { pathFromMount } from '../transfer/path-guard.js'
import { makeKeyedCoalescer } from '../state/coalesce.js'
import { walkDisk } from './walk-disk.js'
import { exceedsShareFileLimit } from './share-limits.js'
import { PREVIEW_DETAIL_MAX_FILES, includePerFile } from './preview-detail.js'
import { relToDriveKey as relToKey, driveKeyToSegments, shouldIgnore, DEFAULT_IGNORE, isAbsoluteDriveKey, relKeyEscapes } from './path-keys.js'
import { OP, PRIORITY } from './work-item.js'
import { mountRootAvailable } from './publish-runner.js'
import { statFacts } from './disk-presence.js'
import { registerPublishChannel, settleCatalog } from './publish-service.js'

export { shouldIgnore, DEFAULT_IGNORE, mountRootAvailable }

const log = createLogger('owned-folders')

let ipcRef = null
// Injected by the worker: maps a scan outcome onto the mount's durable status and the live UI
// event. Unset outside the worker (integration helpers).
let settleScanRef = null
// Injected by the worker: owner→member broadcast of this share's queue depth. Unset outside the
// worker (integration helpers) and when the feature flag is off.
let broadcastIndexRef = null

// Set by OwnedFolders._open. The channel and the coalescer below are module-level (they arm
// nothing at import), so they reach the running instance's scheduler through here.
let scheduler = null
function sched() {
  if (!scheduler) throw new Error('owned-folders: not started')
  return scheduler
}

const reconcileTimers = new Map()
// Catch-up passes currently walking a mount, and the latch that stops new ones being armed. A
// catch-up re-arms ITSELF while files are still settling, so clearing the timers is not enough:
// without the latch a pass that resolves during teardown schedules another one on a closed store.
const catchupInFlight = new Set()
let stopping = false
const POST_EVENT_RECONCILE_MS = 2000
// A catch-up that deferred a still-settling file re-arms itself with this backoff, so a file
// written for minutes on end (a log) costs a stat walk every minute, not every two seconds.
const CATCHUP_BACKOFF_MAX_MS = 60000
// Longer than chokidar's awaitWriteFinish stabilityThreshold, so a catch-up diff that runs
// mid-copy leaves the file to the watcher instead of reading it and reverting.
const SCAN_SETTLE_MS = 2000

const shareCache = new Map()

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

// Members learn of a scan from frames sent when the queue changes SHAPE — and a queue sitting
// behind one multi-GB hash changes shape twice in several minutes. A member who opens the folder in
// between, or who reconnects mid-scan, would otherwise see nothing at all, which is exactly the case
// this feature exists for. So an active share re-announces itself on a timer: ephemeral status is
// re-announced, never replayed, and the frame is idempotent, so a missed one costs latency only.
const INDEX_ANNOUNCE_MS = 5000
const announcing = new Map()
let announceTimer = null
// Injected so a test can drive the re-announce without waiting out the real cadence.
let announceMs = INDEX_ANNOUNCE_MS

function announceIndex(spaceId, shareId) {
  const status = scheduler?.statusFor(spaceId, shareId)
  if (!(status?.adding > 0)) return false
  broadcastIndexRef?.(spaceId, { shareId, adding: status.adding, bytesQueued: status.bytesQueued })
  return true
}

// Runs only while some share is scanning, and stops itself the moment none is.
function armIndexAnnounce() {
  if (announceTimer || announcing.size === 0) return
  announceTimer = setInterval(() => {
    for (const [key, at] of announcing) if (!announceIndex(at.spaceId, at.shareId)) announcing.delete(key)
    if (announcing.size === 0) { clearInterval(announceTimer); announceTimer = null }
  }, announceMs)
  announceTimer.unref?.()
}

export function stopIndexAnnounce() {
  if (announceTimer) clearInterval(announceTimer)
  announceTimer = null
  announcing.clear()
}

const progress = makeKeyedCoalescer((spaceId, shareId) => {
  // Tolerant: the publish service drains its executors AFTER this subsystem closes, and each
  // settling item pokes progress on the way out.
  const status = scheduler?.statusFor(spaceId, shareId)
  if (!status) return
  ipcRef?.emit('event:owned-folder-index-progress', { spaceId, shareId, ...status })
  // Members see the same queue we do. Only the two numbers a watcher can act on cross the wire —
  // the rest (tallies, ordering, concurrency) is ours and says nothing about their view.
  broadcastIndexRef?.(spaceId, { shareId, adding: status.adding, bytesQueued: status.bytesQueued })
  const key = spaceId + '|' + shareId
  if (status.adding > 0) { announcing.set(key, { spaceId, shareId }); armIndexAnnounce() }
  else announcing.delete(key)
}, { intervalMs: 500, keyOf: (spaceId, shareId) => spaceId + '|' + shareId })

registerPublishChannel('folder', {
  async resolve(item) {
    const mount = await getOwnedMount(item.spaceId, item.shareId)
    if (!mount) return { skip: 'skipped-unmounted' }
    // A missing root is ambiguous (unplugged, offline) and never a delete. When a root vanishes
    // chokidar emits one unlink per file, and every one of them lands here.
    if (!mountRootAvailable(mount.mountPath)) return { skip: 'skipped-root-gone' }
    const share = await loadShare(item.spaceId, item.shareId)
    if (!share || isUnsupportedShare(share)) return { skip: 'skipped' }
    // A relPath that escapes the mount is catalog poison, not a file: no path, so a retire reclaims it.
    let absPath = null
    try { absPath = pathFromMount(mount.mountPath, item.relPath) } catch {}
    return { share, absPath }
  },
  async publish(item, { share, absPath }, opts) {
    return { changed: await getContentBackend(share).publishAdd(item.spaceId, share, item.relPath, absPath, opts) }
  },
  retire(item, { share }, { catalog }) {
    return getContentBackend(share).publishDelete(item.spaceId, share, item.relPath, { catalog })
  },
  onProgress: (spaceId, shareId) => progress.poke(spaceId, shareId),
  onDrained: (spaceId, shareId) => {
    progress.flush(spaceId, shareId)
    settleCatalog(spaceId).then(() => ipcRef?.emit('event:share-files-updated', { spaceId, shareId }))
  },
  onSpaceIdle: (spaceId) => {
    for (const key of [...shareCache.keys()]) if (key.startsWith(spaceId + '\0')) shareCache.delete(key)
  },
})

export function initOwnedFolders(_ipc, { settleScan = null, broadcastIndex = null, indexAnnounceMs = INDEX_ANNOUNCE_MS } = {}) {
  ipcRef = _ipc
  settleScanRef = settleScan
  broadcastIndexRef = broadcastIndex
  announceMs = indexAnnounceMs
  // The presence sweep must never reclaim a path whose publish is queued or running. Installed
  // here rather than by the service, which must not import the backend (import cycle).
  setPendingPublishProbe((spaceId, shareId, relPath) => scheduler?.isPending(spaceId, shareId, relPath) ?? false)
}

// Chokidar can drop `add` events when several files land in a new subfolder at once (macOS
// fsevents coalescing). After watcher activity settles, one catch-up diff publishes stragglers.
// A pass that deferred a still-settling file re-arms itself (with backoff): the deferred file's
// own add may be the one that was dropped, and nothing else would publish it before the periodic
// pass. The mount is re-read for the re-arm, so a share deleted or relocated meanwhile is not
// chased with a stale path.
function scheduleCatchupReconcile(mount, delayMs = POST_EVENT_RECONCILE_MS) {
  if (stopping) return
  const { spaceId, shareId } = mount
  const key = spaceId + ':' + shareId
  clearTimeout(reconcileTimers.get(key))
  const timer = setTimeout(() => {
    reconcileTimers.delete(key)
    if (stopping) return
    const scan = periodicReconcile(spaceId, shareId, mount.mountPath, mount.ignore || DEFAULT_IGNORE, { deferFresh: true })
    // The pass is registered so the subsystem's close can WAIT for it: clearing the timer only
    // stops the next one, and a scan still walking the mount when the store closes reports
    // SESSION_CLOSED into a status write nobody asked for.
    catchupInFlight.add(scan)
    scan.finally(() => catchupInFlight.delete(scan)).catch(() => {})
    scan.then(async (r) => {
      if (stopping || !(r?.deferred > 0) || r.cancelled) return
      const current = await getOwnedMount(spaceId, shareId)
      if (current && !reconcileTimers.has(key)) scheduleCatchupReconcile(current, Math.min(delayMs * 2, CATCHUP_BACKOFF_MAX_MS))
    }).catch(() => {})
    if (settleScanRef) settleScanRef(scan, spaceId, shareId)
    else scan.catch((err) => log.debug('catch-up reconcile failed:', err.message))
  }, delayMs)
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

  const { size, mtime } = statFacts(absPath)
  const { settled } = sched().enqueue({
    spaceId, shareId, relPath: driveRel,
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
function publishVerdict(prev, info, deep, deferFresh) {
  if (deep) return 'publish'
  if (prev && prev.size === info.size && prev.mtime === info.mtime && prev.contentHash) return 'unchanged'
  if (deferFresh && !prev) {
    const age = Date.now() - info.mtime
    if (age >= 0 && age < SCAN_SETTLE_MS) return 'defer'
  }
  return 'publish'
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

  sched().beginShare(spaceId, shareId, onDisk.size)
  const specs = []
  const unchanged = []
  let deferred = 0
  for (const [relPath, info] of onDisk) {
    // A name no catalog key can carry (a '\' in a POSIX file name) is skipped, never a reason to
    // abort the whole diff.
    if (relKeyEscapes(relPath)) { log.warn('skipping file whose name cannot be a share key:', relPath); continue }
    const prev = known.get(relPath)
    const verdict = publishVerdict(prev, info, deep, deferFresh)
    if (verdict === 'defer') { deferred += 1; continue }
    if (verdict === 'unchanged') { unchanged.push([relPath, prev, info]); continue }
    specs.push({ spaceId, shareId, relPath, op: OP.PUBLISH, size: info.size, mtime: info.mtime, deep, priority: PRIORITY.BULK })
  }
  // A catalog key with no file behind it is a retire candidate whatever its shape: an escaping
  // key is poison an older release wrote, and the executor reclaims it without ever resolving
  // a disk path for it.
  for (const [relPath, entry] of known) {
    if (onDisk.has(relPath) || unreadable.has(relPath)) continue
    specs.push({ spaceId, shareId, relPath, op: OP.RETIRE, size: entry.size || 0, priority: PRIORITY.BULK })
  }
  sched().enqueueMany(specs)
  // A file the diff will not touch still gets the publish path's serve-map check: the catalog
  // advertising a hash the serve gate does not hold (a transient registerFile failure) must heal
  // on the next pass, not the next restart.
  for (const [relPath, prev, info] of unchanged) {
    try { await ensureServable(spaceId, shareId, relPath, pathFromMount(mountPath, relPath), prev.contentHash, info.size) } catch (err) {
      log.debug('ensure servable failed:', relPath, '-', err.message)
    }
  }
  await touchOwnedMountScan(spaceId, shareId)
  return { enqueued: specs.length, deferred, totalOnDisk: onDisk.size }
}

// Resolves after this pass's items have settled with { uploaded, deleted, failed, totalOnDisk,
// deferred } — plus `cancelled: true` when the pass was cancelled before they did (its counts are
// then partial and its status must not be recorded) — or with { skipped } when the diff could not run.
export async function initialPublishScan(spaceId, shareId, mountPath, ignore, opts = {}) {
  const r = await reconcileShare(spaceId, shareId, mountPath, ignore, opts)
  if (r.skipped) return { skipped: r.skipped, uploaded: 0, deleted: 0, totalOnDisk: 0 }
  const t = await sched().whenDrained(spaceId, shareId)
  await settleCatalog(spaceId)
  return {
    uploaded: t?.uploaded ?? 0, deleted: t?.deleted ?? 0, failed: t?.failed ?? 0,
    totalOnDisk: r.totalOnDisk, deferred: r.deferred ?? 0,
    ...(t?.cancelled ? { cancelled: true } : {}),
  }
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
  return sched().statusFor(spaceId, shareId)
}

export function cancelIndex(spaceId, shareId) {
  return sched().cancelShare(spaceId, shareId)
}

export function stopOwnedFolder(spaceId, shareId) {
  const key = spaceId + ':' + shareId
  clearTimeout(reconcileTimers.get(key))
  reconcileTimers.delete(key)
  clearShareGuards(shareId)
  // Tolerant on purpose: this is a cleanup path (leave, unmount, a test teardown) and can legally
  // run after the lane has stopped. The enqueue paths above still fail loudly.
  scheduler?.cancelShare(spaceId, shareId)
}

// Owns the owned-folder side as a set: the catch-up timers, the publish scheduler's in-flight
// work and the caches. stopOwnedFolder stays the per-share stop; this is the bulk one shutdown
// needs, and it waits for the publish executors rather than just cancelling them.
export class OwnedFolders extends Subsystem {
  constructor(name, deps) { super(name, deps); this.require('ipc', 'publishService') }

  async _open() {
    scheduler = this.deps.publishService.scheduler
    stopping = false
    initOwnedFolders(this.deps.ipc, {
      settleScan: this.deps.settleScan ?? null,
      broadcastIndex: this.deps.broadcastIndex ?? null,
    })
  }

  async _close() {
    stopping = true
    stopIndexAnnounce()
    setPendingPublishProbe(null)
    for (const timer of reconcileTimers.values()) clearTimeout(timer)
    reconcileTimers.clear()
    // Bounded, like every other drain: the pass itself bails at its next file, and waiting for
    // that bail is what makes closing the cores it reads safe.
    if (catchupInFlight.size) {
      await Promise.race([
        Promise.allSettled([...catchupInFlight]),
        new Promise((resolve) => { const t = setTimeout(resolve, 3000); t.unref?.() }),
      ])
    }
    // The scheduler reference is left in place: PublishService closes after this subsystem and
    // drains its executors, whose settling items still poke the callbacks above.
    progress.reset()
    shareCache.clear()
  }
}

export { walkDisk }
