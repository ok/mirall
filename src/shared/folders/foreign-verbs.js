// The mount verbs of a mirror — start, stop and restart its loop; unmount, relocate and enable the
// mount. Each one is a write to the mount record plus the loop control that keeps the running
// mirror in step with it; the loop and the per-mount state are the root's and arrive injected.
import { MOUNT_STATUS, MIRROR_STATE } from '../contract/statuses.js'
import { AppError } from '../core/errors.js'
import { CODES } from '../contract/errors.js'
import { createLogger } from '../core/logger.js'
import { getForeignMount, mutateForeignMount, deleteForeignMount } from './mount-store.js'
import { setMirrorState, tombstoneMirror } from './mirror-records.js'
import { emitMirrorEvent, emitStatus, syncMirrorRecord } from './mirror-signals.js'
import { forgetMirrorFetch } from './mirror-fetch.js'
import { initialMaterializeScan, runMaterializeTick } from './mirror-pass.js'
import { recordMirrorScanFault } from './foreign-pause.js'
import { mirrorKey } from './mirror-policy.js'
import { memberWaits } from '../network/share-wait.js'
import { SHARE_WAIT_SOURCE } from '../transfer/share-wait-set.js'

const log = createLogger('foreign-verbs')

let loops = null
let state = null

export function initForeignVerbs(d) {
  loops = d.loops
  state = d.state
}

export async function startForeignLoop(mount) {
  loops.start(mirrorKey(mount.spaceId, mount.shareId), { spaceId: mount.spaceId, shareId: mount.shareId })
}

// Un-wedge one mirror: the stop generation-invalidates a hung pass so it bails at its next
// checkpoint without writing, and the restart drops the dead in-flight promise the stop leaves
// behind — without that the fresh interval coalesces straight back onto it.
export async function restartForeignLoop(spaceId, shareId) {
  loops.restart(mirrorKey(spaceId, shareId), { spaceId, shareId })
    .catch((err) => log.debug('materialize tick after restart failed:', err.message))
}

const WALK_REQUEST_DEBOUNCE_MS = 250

// A reader that saw a mirrored file diverge from what the mirror verified asks for a walk rather
// than acting on it, and the walk settles the file. No write, so a listing may call it. A converged
// mirror is skipping ticks, so it is poked now; one still walking every tick is left to it, which
// keeps a file the pass cannot settle from turning every re-list into another pass.
export function requestMirrorWalk(spaceId, shareId) {
  const key = mirrorKey(spaceId, shareId)
  if (state?.requestWalk(key) && loops.live(key)) loops.debounce(key, { spaceId, shareId }, WALK_REQUEST_DEBOUNCE_MS)
}

export function stopForeignLoop(spaceId, shareId, { discardPartial = false } = {}) {
  loops.stop(mirrorKey(spaceId, shareId), { discardPartial })
  memberWaits.cancelShare(spaceId, shareId, SHARE_WAIT_SOURCE.MIRROR)
}

// Unmount and relocate both come through here: the caches are keyed by the mount path in effect
// (state.reset says why).
function resetForeignSyncState(spaceId, shareId) {
  const key = mirrorKey(spaceId, shareId)
  state.reset(key)
  loops.forgetLiveness(key)
}

export async function unmountForeignFolder(spaceId, shareId) {
  stopForeignLoop(spaceId, shareId, { discardPartial: true })
  // Only here, not in stopForeignLoop: that runs on pause and on a health restart too, and
  // re-arming there would re-record the same mismatch on every resume.
  forgetMirrorFetch(mirrorKey(spaceId, shareId))
  // Overlay copies no bytes into a drive (it serves straight from the owner's
  // source), so there is no per-share blob cache to reclaim on unmount — the
  // materialized files stay on disk, matching owner-delete behaviour.
  await deleteForeignMount(spaceId, shareId)
  resetForeignSyncState(spaceId, shareId)
  await syncMirrorRecord(spaceId, shareId, () => tombstoneMirror(spaceId, shareId))
  emitStatus(spaceId, shareId, MOUNT_STATUS.IDLE)
  emitMirrorEvent('event:share-files-updated', { spaceId, shareId })
}

// The initial scan, with its fault recorded under the scan's own generation. Resolves true when the
// scan got through, false when it faulted.
export async function scanForeignMount(mount) {
  const gen = loops.generationOf(mirrorKey(mount.spaceId, mount.shareId))
  try {
    await initialMaterializeScan(mount)
    return true
  } catch (err) {
    log.warn('mirror initial scan failed:', mount.shareId, '-', err.message)
    await recordMirrorScanFault(mount.spaceId, mount.shareId, err, { gen })
      .catch((e) => log.debug('mirror scan fault record failed:', mount.shareId, '-', e.message))
    return false
  }
}

// Move the mount, not the bytes. `discardPartial` is deliberately NOT passed to the stop: a
// half-written file at the old path is the user's to keep or delete, and deleting it here would
// destroy data the relocate never promised to touch.
//
// Everything that can fail happens BEFORE anything is torn down — same rule as pauseMount and
// resumeIndex — so a failed write leaves a mount that is still running against its old path rather
// than one with no loop, no caches and a record that disagrees with both. The invalidation is not a
// teardown: it cancels the passes over the old path, and the cadence stays armed.
export async function relocateForeignFolder(spaceId, shareId, mountPath) {
  const key = mirrorKey(spaceId, shareId)
  loops.invalidate(key)
  const mount = await getForeignMount(spaceId, shareId)
  if (!mount) throw new AppError(CODES.MOUNT_NOT_ON_DEVICE, 'Mount not found')

  // Decided inside the write, against the record as it is then, so a pause that lands after the
  // read above keeps its enabled/status. A disabled mount keeps the status and reason it was
  // disabled WITH: collapsing an auto-pause ('mount-point-gone', 'paused-enospc') into a plain user
  // 'paused' would take it out of the auto-pause set and permanently disable the auto-resume that
  // exists to rescue exactly the mirrors this verb is used on. An enabled one re-enters at
  // scanning, and its old path's fault reason goes with it.
  const patched = await mutateForeignMount(spaceId, shareId, (m) => {
    const enabled = m.enabled !== false
    return {
      ...m,
      mountPath,
      syncedPaths: [],
      renamedPaths: {},
      status: enabled ? MOUNT_STATUS.SCANNING : (m.status ?? MOUNT_STATUS.PAUSED),
      lastError: enabled ? null : (m.lastError ?? null),
    }
  })
  if (!patched) throw new AppError(CODES.MOUNT_NOT_ON_DEVICE, 'Mount not found')
  const written = await getForeignMount(spaceId, shareId)
  const status = written?.status ?? MOUNT_STATUS.PAUSED

  stopForeignLoop(spaceId, shareId)
  resetForeignSyncState(spaceId, shareId)
  // stopForeignLoop deliberately leaves the in-flight pass alone; without this a pass still
  // running against the OLD path makes every later tick coalesce onto that dead promise, and
  // because a coalesced call never marks a pass started, the liveness probe reports it healthy.
  loops.dropInFlight(key)
  emitStatus(spaceId, shareId, status)

  // Every await below is a window for a pause or another relocate, which invalidates `at`.
  const at = loops.generationOf(key)
  const next = await getForeignMount(spaceId, shareId)
  if (next && next.enabled !== false && !loops.stopped(key, at)) {
    await syncMirrorRecord(spaceId, shareId,
      () => setMirrorState(spaceId, shareId, 'syncing', { stopped: () => loops.stopped(key, at) }))
    if (!loops.stopped(key, at)) rearmRelocated(next)
  }
  emitMirrorEvent('event:share-files-updated', { spaceId, shareId })
  return next
}

// The initial scan, not a tick: it is the pass that closes 'scanning', and it runs adopt-only while
// the owner is offline. It gets its own copy of the record, which it fills in as it goes; the tick
// after it settles a share whose listing the scan would not call complete.
function rearmRelocated(next) {
  const { spaceId, shareId } = next
  startForeignLoop(next)
  scanForeignMount({ ...next, renamedPaths: { ...next.renamedPaths } })
    .then((scanned) => scanned && runMaterializeTick(spaceId, shareId))
    .catch((err) => log.debug('relocate tick failed:', shareId, '-', err.message))
}

export async function setForeignEnabled(spaceId, shareId, enabled) {
  // A pause cancels every pass before its write, so none can write over it; the loop is stopped
  // only once the write has landed.
  if (!enabled) loops.invalidate(mirrorKey(spaceId, shareId))
  const mount = await getForeignMount(spaceId, shareId)
  if (!mount) throw new AppError(CODES.MOUNT_NOT_ON_DEVICE, 'Mount not found')
  const wasEnabled = mount.enabled !== false
  mount.enabled = enabled
  mount.status = enabled ? MOUNT_STATUS.ACTIVE : MOUNT_STATUS.PAUSED
  if (enabled) mount.lastError = null
  await mutateForeignMount(spaceId, shareId, (m) => ({
    ...m,
    enabled,
    status: enabled ? MOUNT_STATUS.ACTIVE : MOUNT_STATUS.PAUSED,
    ...(enabled ? { lastError: null } : {}),
    ...state.syncFields(m),
  }))
  if (enabled) {
    await startForeignLoop(mount)
    // Only a genuine resume (was paused) touches the record and re-evaluates now: set 'syncing',
    // then kick an immediate tick so a mirror with nothing left to fetch settles straight back to
    // 'synced' instead of blinking for a whole poll interval. A redundant enable of an already-
    // active mount must not blink 'synced'->'syncing'.
    if (!wasEnabled) {
      await syncMirrorRecord(spaceId, shareId, () => setMirrorState(spaceId, shareId, 'syncing'))
      runMaterializeTick(spaceId, shareId).catch((err) => log.debug('foreign resume tick failed:', shareId, '-', err.message))
    }
  } else {
    stopForeignLoop(spaceId, shareId)
    await syncMirrorRecord(spaceId, shareId, () => setMirrorState(spaceId, shareId, MIRROR_STATE.PAUSED))
  }
  emitStatus(spaceId, shareId, mount.status)
  return mount
}
