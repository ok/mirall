// The mount verbs of a mirror — start, stop and restart its loop; unmount, relocate and enable the
// mount. Each one is a write to the mount record plus the loop control that keeps the running
// mirror in step with it; the loop and the per-mount state are the root's and arrive injected.
import { MOUNT_STATUS, MIRROR_STATE } from '../contract/statuses.js'
import { AppError } from '../core/errors.js'
import { CODES } from '../contract/errors.js'
import { createLogger } from '../core/logger.js'
import { getForeignMount, mutateForeignMount, deleteForeignMount, patchForeignMount } from './mount-store.js'
import { setMirrorState, tombstoneMirror } from './mirror-records.js'
import { emitMirrorEvent, emitStatus, syncMirrorRecord } from './mirror-signals.js'
import { forgetMirrorFetch } from './mirror-fetch.js'
import { initialMaterializeScan, runMaterializeTick } from './mirror-pass.js'
import { mirrorKey } from './mirror-policy.js'

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

export function stopForeignLoop(spaceId, shareId, { discardPartial = false } = {}) {
  loops.stop(mirrorKey(spaceId, shareId), { discardPartial })
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

// Move the mount, not the bytes. `discardPartial` is deliberately NOT passed to the stop: a
// half-written file at the old path is the user's to keep or delete, and deleting it here would
// destroy data the relocate never promised to touch.
//
// Everything that can fail happens BEFORE anything is torn down — same rule as pauseMount and
// resumeIndex — so a failed write leaves a mount that is still running against its old path rather
// than one with no loop, no caches and a record that disagrees with both.
export async function relocateForeignFolder(spaceId, shareId, mountPath) {
  const mount = await getForeignMount(spaceId, shareId)
  if (!mount) throw new AppError(CODES.MOUNT_NOT_ON_DEVICE, 'Mount not found')

  const enabled = mount.enabled !== false
  // A disabled mount keeps the status it was disabled WITH. Collapsing an auto-pause
  // ('mount-point-gone', 'paused-enospc') into a plain user 'paused' would take it out of the
  // auto-pause set and permanently disable the auto-resume that exists to rescue exactly the
  // mirrors this verb is used on.
  const status = enabled ? MOUNT_STATUS.SCANNING : (mount.status ?? MOUNT_STATUS.PAUSED)
  // A read-merge, never a whole-object write-back: the snapshot above predates this await, so
  // putting it back would resurrect an `enabled`/`status` a concurrent pause had already written.
  const patched = await patchForeignMount(spaceId, shareId, { mountPath, status, syncedPaths: [], renamedPaths: {} })
  if (!patched) throw new AppError(CODES.MOUNT_NOT_ON_DEVICE, 'Mount not found')

  stopForeignLoop(spaceId, shareId)
  resetForeignSyncState(spaceId, shareId)
  // stopForeignLoop deliberately leaves the in-flight pass alone; without this a pass still
  // running against the OLD path makes every later tick coalesce onto that dead promise, and
  // because a coalesced call never marks a pass started, the liveness probe reports it healthy.
  loops.dropInFlight(mirrorKey(spaceId, shareId))
  emitStatus(spaceId, shareId, status)

  const next = await getForeignMount(spaceId, shareId)
  if (enabled && next) {
    await syncMirrorRecord(spaceId, shareId, () => setMirrorState(spaceId, shareId, 'syncing'))
    await startForeignLoop(next)
    // The initial scan, not a tick: it is the pass that closes 'scanning', and it adopts whatever
    // already sits at the new path.
    initialMaterializeScan(next).catch((err) => log.debug('relocate scan failed:', shareId, '-', err.message))
  }
  emitMirrorEvent('event:share-files-updated', { spaceId, shareId })
  return next
}

export async function setForeignEnabled(spaceId, shareId, enabled) {
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
