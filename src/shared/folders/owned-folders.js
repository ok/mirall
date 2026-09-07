// Owner side of folder sharing: keeps a mounted disk folder (an "owned folder") published into
// its share's catalog. Every producer — mount, relocate, boot, the watcher, the catch-up and the
// periodic reconcile — computes a diff and enqueues work items on the shared publish service; the
// folder channel registered here resolves, publishes and retires them. A missing mount root always
// pauses publishing instead of tombstoning the catalog.
import path from 'bare-path'
import { ignorePathsFor, clearShareGuards } from './echo-guard.js'
import { getOwnedMount, touchOwnedMountScan, findOwnedMountByShareId } from './mount-store.js'
import { AppError, ErrorCodes, classifyLocalIoFault } from '../core/errors.js'
import { createLogger } from '../core/logger.js'
import { Subsystem } from '../core/subsystem.js'
import { liveHandle, ownedScheduler } from '../core/timers.js'
import { createCoalescingRunner } from '../core/coalescing-runner.js'
import { createPassLiveness } from '../core/pass-liveness.js'
import { getContentBackend, isUnsupportedShare } from '../transfer/content-backends.js'
import { listOwnShare } from '../shares/share-catalog.js'
import { ensureServable, setFolderPublishLane } from '../transfer/backends/overlay/overlay-backend.js'
import { pathFromMount } from '../transfer/path-guard.js'
import { makeKeyedCoalescer } from '../state/coalesce.js'
import { countDiskFiles, walkDisk } from './walk-disk.js'
import { relToDriveKey as relToKey, shouldIgnore, DEFAULT_IGNORE, isAbsoluteDriveKey, relKeyEscapes } from './path-keys.js'
import { OP, PRIORITY } from './work-item.js'
import { mountRootAvailable } from './publish-runner.js'
import { statFacts } from './disk-presence.js'
import { registerPublishChannel, settleCatalog } from './publish-service.js'
import { getReconcileStallWindowMs } from '../core/runtime-config.js'

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

// The live subsystem, so the module-scope functions below can arm through ITS timer set. Every
// handle they hold outlives the call that armed it, so nothing scoped to the call can clear it —
// and _close alone is not enough: ReadyResource ends a FAILED _open by running close() without
// ever calling _close, and a _close that rejects short-circuits the same way. Subsystem clears
// `this.timers` on both of those paths as well as the ordinary one.
let subsystem = null

const reconcileTimers = new Map()
// Diff passes currently reading a mount. A pause or a stop must reach the pass itself, not just the
// queue it is about to fill: cancelShare empties a queue, and the pass then hands enqueueMany
// everything it walked — so on a large tree the index restarts the moment that read lands.
const scanSignals = new Map()
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
// How often a phase that iterates without touching the disk (the catalog drain, the diff) bumps the
// pass heartbeat. Often enough that no phase can go quiet for the stall window, rare enough that the
// bookkeeping is not itself the cost.
const LIVENESS_EVERY = 500
// Tracked on the PASS, not on the coalescing wrapper: a caller that joins a run in flight must
// not re-stamp its heartbeat and make a stalled pass read as fresh.
const passLiveness = createPassLiveness()
// Shares whose reconcile pass the supervisor abandoned and which have not been scanned since.
// Kept because a unit that vanishes the moment we act on it takes its strike counter with it: the
// policy prunes counters for rows nobody reports any more, so the recovery budget reset on every
// attempt, `maxRecoveries` could never be reached, and the one error line that names the folder we
// have given up on could never print. It is also the honest state — nothing is scanning that
// folder, and the periodic reconcile is six hours away.
const abandoned = new Set()

const shareCache = new Map()

// The worst classified I/O fault seen since the last pass settled, per (space, share). Every item
// that failed used to be counted by the scheduler and then dropped, so a pass whose every publish
// hit a full disk still resolved as a clean scan and settled the mount to 'active'. A full disk
// outranks a permission fault: it is the one that stops the whole device rather than one subtree.
// Drained by whichever pass settles next rather than cleared when one starts — a watcher item that
// failed between passes is the live case, and clearing at the start would throw exactly that away.
const passFaults = new Map()
const faultKey = (spaceId, shareId) => spaceId + '\0' + shareId

function recordPassFault(spaceId, shareId, err) {
  const code = classifyLocalIoFault(err)
  if (!code) return
  const key = faultKey(spaceId, shareId)
  if (passFaults.get(key) === ErrorCodes.TRANSFER_DISK_FULL) return
  passFaults.set(key, code)
}

function takePassFault(spaceId, shareId) {
  const key = faultKey(spaceId, shareId)
  const code = passFaults.get(key) ?? null
  passFaults.delete(key)
  return code
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
  // See startPresenceHeartbeat: a _close that rejects leaves this binding holding a handle its set
  // has already disarmed, and the guard below would read that as "already armed" forever.
  announceTimer = liveHandle(subsystem?.timers, announceTimer)
  if (announceTimer || announcing.size === 0 || !subsystem || subsystem.timers.closed) return
  announceTimer = subsystem.timers.setInterval(() => {
    for (const [key, at] of announcing) if (!announceIndex(at.spaceId, at.shareId)) announcing.delete(key)
    if (announcing.size === 0) stopIndexAnnounce()
  }, announceMs)
}

export function stopIndexAnnounce() {
  if (announceTimer) subsystem?.timers.clear(announceTimer)
  announceTimer = null
  announcing.clear()
}

const progress = makeKeyedCoalescer((spaceId, shareId) => {
  // The publish service drains its executors AFTER this subsystem closes, and each settling item
  // pokes progress on the way out. With no live subsystem there is no timer set to hold the window
  // open, so every one of those pokes would fire on its own — turning one throttled frame per
  // 500 ms into one broadcast per drained item, at shutdown, into a swarm being torn down. Nobody
  // is left to act on index progress by then: the drain is silent.
  if (!subsystem) return
  const status = scheduler?.statusFor(spaceId, shareId)
  if (!status) return
  ipcRef?.emit('event:owned-folder-index-progress', { spaceId, shareId, ...status })
  // Members see the same queue we do. Only the two numbers a watcher can act on cross the wire —
  // the rest (tallies, ordering, concurrency) is ours and says nothing about their view.
  broadcastIndexRef?.(spaceId, { shareId, adding: status.adding, bytesQueued: status.bytesQueued })
  const key = spaceId + '|' + shareId
  if (status.adding > 0) { announcing.set(key, { spaceId, shareId }); armIndexAnnounce() }
  else announcing.delete(key)
}, {
  intervalMs: 500,
  keyOf: (spaceId, shareId) => spaceId + '|' + shareId,
  // The coalescer's trailing timer is the same long-lived handle as the two above, one level down:
  // it is held in the engine's own map and its only clear is progress.reset(), which a _close that
  // rejects never reaches. Read lazily, because this is constructed at module load and the
  // subsystem does not exist yet; before _open there is nothing to coalesce anyway.
  ...ownedScheduler(() => subsystem?.timers),
})

registerPublishChannel('folder', {
  async resolve(item) {
    const mount = await getOwnedMount(item.spaceId, item.shareId)
    if (!mount) return { skip: 'skipped-unmounted' }
    // The watcher does not go through the diff: onFsEvent enqueues straight onto the scheduler on
    // the INTERACTIVE lane, so a file edited during a pause would publish past the scan's own gate.
    // Dropping it is the same recovery shape as skipped-root-gone — the resume scan re-derives it.
    if (mount.indexPaused) return { skip: 'skipped-index-paused' }
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
  onPublishFailed: (item, _ctx, err) => recordPassFault(item.spaceId, item.shareId, err),
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
  // The backend's presence sweep proposes reclaims onto this lane rather than writing tombstones
  // itself. Installed here rather than by the service, which must not import the backend.
  setFolderPublishLane({
    isPending: (spaceId, shareId, relPath) => scheduler?.isPending(spaceId, shareId, relPath) ?? false,
    enqueueRetire: (spaceId, shareId, relPath) => sched().enqueue({ spaceId, shareId, relPath, op: OP.RETIRE, priority: PRIORITY.BULK }).settled,
    // A bulk retire writes through the space's catalog batch, so the item settles before the
    // tombstone is durable. An awaited sweep has to outlast the flush, not the enqueue.
    settle: (spaceId) => settleCatalog(spaceId),
  })
}

// Chokidar can drop `add` events when several files land in a new subfolder at once (macOS
// fsevents coalescing). After watcher activity settles, one catch-up diff publishes stragglers.
// A pass that deferred a still-settling file re-arms itself (with backoff): the deferred file's
// own add may be the one that was dropped, and nothing else would publish it before the periodic
// pass. The mount is re-read for the re-arm, so a share deleted or relocated meanwhile is not
// chased with a stale path.
function scheduleCatchupReconcile(mount, delayMs = POST_EVENT_RECONCILE_MS) {
  if (stopping || !subsystem) return
  const { spaceId, shareId } = mount
  const key = spaceId + ':' + shareId
  subsystem.timers.clear(reconcileTimers.get(key))
  const timer = subsystem.timers.setTimeout(() => {
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
  // What a queued caller receives when a wedged pass is abandoned under it. The same shape
  // bailIfAborted returns, so no caller of reconcileShare learns a new outcome.
  cancelledValue: { cancelled: true, totalOnDisk: 0 },
})

// The pass key is `spaceId + ':' + shareId` and neither id contains a colon, so the split is on
// the FIRST separator — a share id that ever gains one must not shift the boundary.
function splitPassKey(key) {
  const at = key.indexOf(':')
  return at < 0 ? [null, null] : [key.slice(0, at), key.slice(at + 1)]
}

async function reconcileShare(spaceId, shareId, mountPath, ignore, { deep = false, deferFresh = false } = {}) {
  const key = spaceId + ':' + shareId
  return await runDiff(key, { mountPath, ignore, deep, deferFresh }, async (opts) => {
    // The token is what makes an abandoned pass inert here: a wedged diff that unparks after its
    // key was recovered would otherwise clear the heartbeat of the fresh pass that replaced it,
    // and that pass would then be invisible to the supervisor for the rest of its life.
    const pass = passLiveness.started(key)
    // Registered for the whole pass rather than only for the read half. abortScan reaches whatever
    // is in scanSignals, and the read half used to hand its signal back the moment it returned — so
    // a pause, a stop or a supervisor recovery arriving during the self-heal loop that follows
    // (the long pole on a large, fully synced share) stopped nothing at all, while the key it
    // freed let a second pass start over the same mount.
    const signal = { aborted: false }
    scanSignals.set(key, signal)
    try {
      const result = await diffAndEnqueue(spaceId, shareId, opts, pass, signal)
      // Cleared on a pass that reached a DECISION, not on one that merely started: a pass that
      // starts and immediately throws would otherwise drop the share from the reported units, and
      // the policy prunes the strike counter of anything nobody reports.
      if (!result?.cancelled) abandoned.delete(key)
      return result
    } finally {
      if (scanSignals.get(key) === signal) scanSignals.delete(key)
      passLiveness.ended(key, pass)
    }
  })
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

// Which of the two abort routes ended a pass decides what the caller records: a pause settles the
// durable status to 'paused', a stop records nothing at all and lets the cadence pick it back up.
async function bailIfAborted(spaceId, shareId, signal) {
  const mount = await getOwnedMount(spaceId, shareId)
  if (mount?.indexPaused) return { skipped: 'index-paused', totalOnDisk: 0 }
  if (signal.aborted) return { cancelled: true, totalOnDisk: 0 }
  return null
}

// Reads both sides of the diff — the disk walk and the catalog — under an abort signal registered
// for this share, so a pause or a stop can end the pass instead of being overwritten by it. The
// signal reaches walk-disk per file; the re-check afterwards covers the rest of the window, because
// the caller's enqueueMany is the point of no return and the catalog read is O(catalog).
//
// The signal cannot interrupt walk-disk's initial recursive readdir, only the stat loop that
// follows it, so a very deep tree still pays that enumeration in full.
async function readBothSides(spaceId, shareId, mountPath, ignore, pass, signal) {
  const key = spaceId + ':' + shareId
  try {
    const walk = await walkDisk(mountPath, ignore, { signal, onProgress: () => passLiveness.progress(key, pass) })
    // Every phase after the walk beats too. The walk is the only one that reports per file, so a
    // pass whose catalog side is the slow half — a large share, a flush window that just closed —
    // used to go quiet for the whole stall window and be reported as wedged while it was working.
    passLiveness.progress(key, pass)
    // Commit the space batch first, or this read misses every hash materialized in the last flush
    // window and re-enqueues those files.
    await settleCatalog(spaceId)
    passLiveness.progress(key, pass)
    const known = new Map()
    for await (const entry of listOwnShare(spaceId, shareId)) {
      known.set(entry.relPath, entry)
      if (known.size % LIVENESS_EVERY === 0) passLiveness.progress(key, pass)
    }
    const bail = await bailIfAborted(spaceId, shareId, signal)
    return bail ? { bail } : { walk, known }
  } catch (err) {
    // walk-disk raises PREVIEW_CANCELLED for any aborted walk, preview or not.
    if (err?.code !== 'PREVIEW_CANCELLED') throw err
    // The `??` is load-bearing: an aborted walk has no result to hand back, so a null bail here
    // would fall through to the caller destructuring an undefined walk.
    return { bail: (await bailIfAborted(spaceId, shareId, { aborted: true })) ?? { cancelled: true, totalOnDisk: 0 } }
  }
}

async function diffAndEnqueue(spaceId, shareId, { mountPath, ignore, deep, deferFresh }, pass, signal) {
  const key = spaceId + ':' + shareId
  const mount = await getOwnedMount(spaceId, shareId)
  if (!mount) throw new AppError(ErrorCodes.MOUNT_NOT_ON_DEVICE, 'Mount missing')
  // Before the walk rather than before the enqueue: the walk is the expensive half on a large tree.
  // It is also what makes a pause survive a restart by construction — boot's resume pass, the
  // reconcile timer and the watcher's catch-up all call in through here.
  if (mount.indexPaused) return { skipped: 'index-paused', totalOnDisk: 0 }
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

  const { walk, known, bail } = await readBothSides(spaceId, shareId, mountPath, ignore, pass, signal)
  if (bail) return bail
  const { onDisk, unreadable } = walk
  passLiveness.progress(key, pass)

  sched().beginShare(spaceId, shareId, onDisk.size)
  const specs = []
  const unchanged = []
  let deferred = 0
  for (const [relPath, info] of onDisk) {
    // No beat in here, deliberately: this loop never awaits, so on the worker's single thread no
    // probe can run between its iterations — only the stamps on either side of it are ever read. A
    // heartbeat here cannot be observed, and one that cannot be observed makes the phase look
    // covered. The beat that matters is in the ensureServable loop below, which does await.
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
    // The one phase after the point of no return that can still be stopped, and on a large fully
    // synced share the longest one in the pass. The work already enqueued stands — this is the
    // self-heal, not the diff — so a stop just ends the sweep rather than invalidating the pass.
    if (signal.aborted) break
    // Per file, like the walk's own callback: ensureServable is free only while the serve
    // reference is present, and after a restart the serve map is empty — so every unchanged file
    // pays a registerFile and this becomes the long pole of the whole pass on a large, fully
    // synced share. LIVENESS_EVERY throttles the loops where the bookkeeping could itself become
    // the cost; next to an await on real I/O a Map lookup is free, and throttling here could skip
    // the entire window on a share with fewer files than the interval.
    passLiveness.progress(key, pass)
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
  // A pass that declined to run reports no fault and CONSUMES none: the fault it would have
  // carried was observed by something else and is still unreported, so it waits for a pass that
  // actually settles rather than dying with this one.
  if (r.skipped) return { skipped: r.skipped, uploaded: 0, deleted: 0, totalOnDisk: 0 }
  // A diff aborted mid-walk enqueued nothing, so there is no drain to park on and no tally to
  // collect — falling through would read the missing tally as a clean finish and record 'active'.
  if (r.cancelled) return { cancelled: true, uploaded: 0, deleted: 0, failed: 0, totalOnDisk: 0, deferred: 0 }
  const t = await sched().whenDrained(spaceId, shareId)
  await settleCatalog(spaceId)
  const faultCode = takePassFault(spaceId, shareId)
  return {
    uploaded: t?.uploaded ?? 0, deleted: t?.deleted ?? 0, failed: t?.failed ?? 0,
    totalOnDisk: r.totalOnDisk, deferred: r.deferred ?? 0,
    ...(faultCode ? { faultCode } : {}),
    ...(t?.cancelled ? { cancelled: true } : {}),
  }
}

export const periodicReconcile = initialPublishScan

// The count the worker's admission gate reads. It counts what is on disk under the same key rule
// the publish scan walks by, INCLUDING files the scan will set aside as unreadable — so the gate
// can only ever be stricter than the scan, never looser, and can never admit a folder the scan
// would then find too large.
export async function countFolderFiles(mountPath, ignore) {
  return await countDiskFiles(mountPath, ignore)
}

export function getIndexStatus(spaceId, shareId) {
  return sched().statusFor(spaceId, shareId)
}

// Stops a walk in progress. walk-disk honours the signal per file (it is how cancel-preview
// works); the scan path simply never passed one.
export function abortScan(spaceId, shareId) {
  const signal = scanSignals.get(spaceId + ':' + shareId)
  if (signal) signal.aborted = true
  return !!signal
}

export function cancelIndex(spaceId, shareId) {
  abortScan(spaceId, shareId)
  return sched().cancelShare(spaceId, shareId)
}

export function stopOwnedFolder(spaceId, shareId) {
  const key = spaceId + ':' + shareId
  // Tolerant of a closed subsystem: this is a cleanup path that can legally run after it, and the
  // set has already been emptied by then.
  subsystem?.timers.clear(reconcileTimers.get(key))
  reconcileTimers.delete(key)
  // An unmounted share is not an unhealthy one: the row has to go, or the supervisor reports a
  // folder that is no longer there for the life of the process.
  abandoned.delete(key)
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
    subsystem = this
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
    setFolderPublishLane(null)
    for (const timer of reconcileTimers.values()) this.timers.clear(timer)
    reconcileTimers.clear()
    for (const signal of scanSignals.values()) signal.aborted = true
    // Before the set is emptied: cancelling settles every caller parked on a pass we are about to
    // abandon. Dropping the key without settling them leaves the catch-up chain holding a promise
    // that never resolves, so catchupInFlight never drains and every later close burns its full
    // bounded wait on it.
    for (const key of scanSignals.keys()) runDiff.cancel(key)
    scanSignals.clear()
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
    passFaults.clear()
    shareCache.clear()
    passLiveness.clear()
    abandoned.clear()
    subsystem = null
  }

  // One unit per reconcile pass in flight, keyed by space and share. The label is the same string:
  // the worker log names a unit, and the redacted health() below — which reaches the shareable
  // diagnostics bundle — counts them instead.
  supervise({ now = Date.now() } = {}) {
    if (this.closed || this.stopping) return []
    const rows = passLiveness.verdicts({ now, windowMs: getReconcileStallWindowMs() })
      .map((row) => ({ ...row, label: row.key }))
    const live = new Set(rows.map((row) => row.key))
    // A share we abandoned and have not scanned since, reported until one does. Not recoverable:
    // there is no pass left to abandon, and the next scan is the cadence's job. Reporting it is
    // the point — it is what carries the strike counter across the gap between passes, so a mount
    // that wedges every pass is eventually given up on by name instead of retried forever.
    for (const key of abandoned) {
      if (live.has(key)) continue
      rows.push({ key, label: key, ok: false, recoverable: false, detail: 'scan abandoned, not yet re-run' })
    }
    return rows
  }

  // Abandon the wedged diff and let the cadence start a fresh one. Three steps, none optional: the
  // abort signal stops the walk at its next file, the runner drops the key so the next request does
  // not coalesce onto a promise that may never settle, and forgetting the heartbeat is what stops
  // the abandoned pass being reported wedged forever. Deliberately does NOT await a fresh pass: the
  // periodic reconcile and the watcher both re-arm one, and awaiting here would hold the
  // supervisor's recovery budget open on the same mount that just wedged.
  async recover(key) {
    if (this.stopping) return
    const [spaceId, shareId] = splitPassKey(key)
    if (!spaceId || !shareId) return
    abortScan(spaceId, shareId)
    runDiff.cancel(key)
    passLiveness.forget(key)
    abandoned.add(key)
    // Re-armed here rather than left to the cadence. The periodic reconcile is six hours out and
    // the watcher only fires on a filesystem event, so an idle share would sit unscanned until
    // then — the abandoned row above would report it, truthfully, for six hours. Safe to start now
    // that the abort signal spans the whole pass: the pass we just abandoned bails at its next
    // checkpoint instead of walking the same mount beside this one.
    const mount = await getOwnedMount(spaceId, shareId)
    // Nothing to scan and nothing to report: the share is no longer mounted here.
    if (!mount) { abandoned.delete(key); return }
    // Deliberately NOT awaited: a fresh pass over a large share legitimately outlives the
    // supervisor's recovery budget, and holding that budget open on the mount that just wedged is
    // the one thing a recovery must not do. If this pass wedges too, the next probe sees it and
    // the strike counter — kept alive by the row above — reaches the give-up limit.
    periodicReconcile(spaceId, shareId, mount.mountPath, mount.ignore || DEFAULT_IGNORE)
      .catch((err) => log.debug('reconcile after recovery failed:', shareId, '-', err.message))
  }

  // The mirror side has reported pass liveness since the supervision contract landed; the owner
  // side never did, so a diff that never settles read as healthy. Counts, not identifiers —
  // diagnostics:export is user-shareable and redacts space and share ids.
  health() {
    const open = !this.closed && !this.stopping
    if (!open) return { ok: false, detail: null }
    const wedged = passLiveness.stalled({ windowMs: getReconcileStallWindowMs() })
    return {
      ok: wedged.length === 0,
      detail: wedged.length ? `${wedged.length} folder scan(s) not advancing` : null,
      scans: { wedged: wedged.length },
    }
  }
}

export { walkDisk }
