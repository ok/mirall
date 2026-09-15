// One reconcile pass over an owned folder: walk the disk, read the catalog, enqueue the difference
// on the publish lane, then wait for it to settle. At most one pass per share is ever in flight,
// and every phase of it reports progress — the supervisor reads a pass that is running and not
// advancing as wedged, and a legitimate pass over thousands of files is genuinely slow.
import { MOUNT_STATUS } from '../contract/statuses.js'
import { AppError } from '../core/errors.js'
import { CODES } from '../contract/errors.js'
import { createLogger } from '../core/logger.js'
import { createCoalescingRunner } from '../core/concurrency.js'
import { createPassLiveness } from '../core/pass-liveness.js'
import { getOwnedMount, touchOwnedMountScan } from './mount-store.js'
import { isUnsupportedShare } from '../transfer/content-backends.js'
import { listOwnShare } from '../shares/share-catalog.js'
import { ensureServable } from '../transfer/backends/overlay/overlay-backend.js'
import { pathFromMount } from './path-guard.js'
import { walkDisk } from './walk-disk.js'
import { relKeyEscapes } from './path-keys.js'
import { OP, PRIORITY } from './work-item.js'
import { mountRootAvailable, settleCatalog } from './publish-service.js'
import { ownedKey, publishVerdict } from './owned-policy.js'
import { loadShareForMount } from './owned-shares.js'

const log = createLogger('owned-folders')

// How often a phase that iterates without touching the disk (catalog drain, diff) bumps the pass
// heartbeat: often enough that no phase goes quiet for the stall window, rare enough to be free.
const LIVENESS_EVERY = 500

// Tracked on the PASS, not the coalescing wrapper: a caller joining a run in flight must not
// re-stamp its heartbeat and make a stalled pass read as fresh.
export const passLiveness = createPassLiveness()

// Diff passes currently reading a mount: a pause or a stop must reach the pass itself, not just the
// queue it is about to fill, or the pass hands enqueueMany everything it walked and the index restarts.
const scanSignals = new Map()

// Injected by owned-folders.js.
let state = null
let scheduler = () => { throw new Error('owned-folders: not started') }
let emit = () => {}

export function initOwnedPass(d) {
  state = d.state
  scheduler = d.scheduler
  emit = d.emit
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

async function reconcileShare(spaceId, shareId, mountPath, ignore, { deep = false, deferFresh = false } = {}) {
  const key = ownedKey(spaceId, shareId)
  state.remember(spaceId, shareId)
  return await runDiff(key, { mountPath, ignore, deep, deferFresh }, async (opts) => {
    // The token is what makes an abandoned pass inert here: a wedged diff that unparks after its
    // key was recovered would otherwise clear the heartbeat of the fresh pass that replaced it,
    // and that pass would then be invisible to the supervisor for the rest of its life.
    const pass = passLiveness.started(key)
    // Registered for the WHOLE pass, not only the read half: abortScan reaches whatever is in
    // scanSignals, and a pause, stop or recovery must also end the self-heal loop that follows the
    // read — the long pole on a large, fully synced share.
    const signal = { aborted: false }
    scanSignals.set(key, signal)
    try {
      const result = await diffAndEnqueue(spaceId, shareId, opts, pass, signal)
      // Cleared on a pass that reached a DECISION, not on one that merely started: a pass that
      // starts and immediately throws would otherwise drop the share from the reported units, and
      // the policy prunes the strike counter of anything nobody reports.
      if (!result?.cancelled) state.unabandon(key)
      return result
    } finally {
      if (scanSignals.get(key) === signal) scanSignals.delete(key)
      passLiveness.ended(key, pass)
    }
  })
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
  const key = ownedKey(spaceId, shareId)
  try {
    const walk = await walkDisk(mountPath, ignore, { signal, onProgress: () => passLiveness.progress(key, pass) })
    // Every phase after the walk beats too: the walk is the only one that reports per file, and a
    // pass whose catalog side is the slow half (a large share, a flush window that just closed) must
    // not go quiet for the stall window and read as wedged.
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
    if (err?.code !== 'PREVIEW_CANCELLED') throw err
    // The `??` is load-bearing: an aborted walk has no result to hand back, so a null bail here
    // would fall through to the caller destructuring an undefined walk.
    return { bail: (await bailIfAborted(spaceId, shareId, { aborted: true })) ?? { cancelled: true, totalOnDisk: 0 } }
  }
}

async function diffAndEnqueue(spaceId, shareId, { mountPath, ignore, deep, deferFresh }, pass, signal) {
  const key = ownedKey(spaceId, shareId)
  const mount = await getOwnedMount(spaceId, shareId)
  if (!mount) throw new AppError(CODES.MOUNT_NOT_ON_DEVICE, 'Mount missing')
  // The root before the pause: a paused INDEX does not make a missing root un-missing, and this
  // pass is the only one a paused mount runs — so reporting 'index-paused' over an absent root
  // leaves the absence unrecorded, and the probe then reads the folder's RETURN as no transition
  // at all.
  //
  // A missing root is ambiguous (transient vs. permanent) and guessing "deleted" would enqueue a
  // retire for every file in the share. Bail without touching the catalog or the queue; the probe
  // loop restarts us when the path returns.
  if (!mountRootAvailable(mountPath)) {
    log.warn('mount path unavailable, skipping reconcile:', mountPath)
    emit('event:owned-folder-mount-status', { spaceId, shareId, status: MOUNT_STATUS.MOUNT_POINT_GONE })
    return { skipped: MOUNT_STATUS.MOUNT_POINT_GONE, totalOnDisk: 0 }
  }
  // Before the walk rather than before the enqueue: the walk is the expensive half on a large tree.
  // It is also what makes a pause survive a restart by construction — boot's resume pass, the
  // reconcile timer and the watcher's catch-up all call in through here.
  if (mount.indexPaused) return { skipped: 'index-paused', totalOnDisk: 0 }
  const share = await loadShareForMount(mount)

  if (isUnsupportedShare(share)) {
    log.warn('skipping scan for unsupported content mode:', share.contentMode, shareId)
    return { skipped: 'unsupported-content-mode', totalOnDisk: 0 }
  }

  const { walk, known, bail } = await readBothSides(spaceId, shareId, mountPath, ignore, pass, signal)
  if (bail) return bail
  const { onDisk, unreadable } = walk
  passLiveness.progress(key, pass)

  scheduler().beginShare(spaceId, shareId, onDisk.size)
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
    const verdict = publishVerdict(prev, info, { deep, deferFresh })
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
  scheduler().enqueueMany(specs)
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
export async function runPublishPass(spaceId, shareId, mountPath, ignore, opts = {}) {
  const r = await reconcileShare(spaceId, shareId, mountPath, ignore, opts)
  // A pass that declined to run reports no fault and CONSUMES none: the fault it would have
  // carried was observed by something else and is still unreported, so it waits for a pass that
  // actually settles rather than dying with this one.
  if (r.skipped) return { skipped: r.skipped, uploaded: 0, deleted: 0, totalOnDisk: 0 }
  // A diff aborted mid-walk enqueued nothing, so there is no drain to park on and no tally to
  // collect — falling through would read the missing tally as a clean finish and record 'active'.
  if (r.cancelled) return { cancelled: true, uploaded: 0, deleted: 0, failed: 0, totalOnDisk: 0, deferred: 0 }
  const t = await scheduler().whenDrained(spaceId, shareId)
  await settleCatalog(spaceId)
  const faultCode = state.takeFault(spaceId, shareId)
  return {
    uploaded: t?.uploaded ?? 0, deleted: t?.deleted ?? 0, failed: t?.failed ?? 0,
    totalOnDisk: r.totalOnDisk, deferred: r.deferred ?? 0,
    ...(faultCode ? { faultCode } : {}),
    ...(t?.cancelled ? { cancelled: true } : {}),
  }
}

// Stops a walk in progress: walk-disk honours the signal per file (it is how cancel-preview
// works), and the scan passes its own token through readBothSides the same way.
export function abortScan(spaceId, shareId) {
  const signal = scanSignals.get(ownedKey(spaceId, shareId))
  if (signal) signal.aborted = true
  return !!signal
}

// Drops the key so the next request does not coalesce onto a promise that may never settle.
export function cancelPass(key) {
  runDiff.cancel(key)
}

// Shutdown: abort every pass, then settle every caller parked on one. Cancelling BEFORE the set is
// emptied matters — dropping a key without settling its callers leaves the catch-up chain holding a
// promise that never resolves, so its in-flight set never drains and every later close burns its
// full bounded wait on it.
export function abortAllPasses() {
  for (const signal of scanSignals.values()) signal.aborted = true
  for (const key of scanSignals.keys()) runDiff.cancel(key)
  scanSignals.clear()
}

// After the abandoned passes have been waited out, not with them: a pass still unwinding during the
// drain would re-stamp a heartbeat cleared any earlier.
export function resetPasses() {
  passLiveness.clear()
}
