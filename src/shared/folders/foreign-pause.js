// The pause / fault / resume ladder for a mirrored mount.
//
// A mirror's pause really does stop it — the poll loop, the in-flight fetch and the generation all
// go with it — which is what separates this from the owner side, where a fault only marks status.
// The initial scan failing is deliberately NOT a pause: the loop still starts and the next good
// tick clears it, so it records the fault without touching `enabled` and stays out of the resume
// gate below.

import fs from 'bare-fs'
import { MIRROR_STATE } from '../contract/statuses.js'
import { classifyLocalIoFault } from '../core/errors.js'
import { faultFromError, STATUS_MOUNT_GONE, statusForFaultCode, isAutoPauseStatus } from './mount-fault.js'
import { getForeignMount, mutateForeignMount } from './mount-store.js'
import { mirrorKey } from './mirror-policy.js'
import { setMirrorState } from './mirror-records.js'
import { emitStatus, syncMirrorRecord } from './mirror-signals.js'
import { mountRootAvailable } from './publish-service.js'

// Injected by foreign-folders.js: the mirror's own state, its loops, and the two loop verbs a pause
// and a resume drive. Importing the verbs would close a cycle through mirror-fetch, which imports
// this module for the I/O pause.
let state = null
let loops = null
let stopForeignLoop = () => {}
let setForeignEnabled = async () => {}

export function initForeignPause(d) {
  state = d.state
  loops = d.loops
  stopForeignLoop = d.stopForeignLoop
  setForeignEnabled = d.setForeignEnabled
}

// `gen` is the generation of the pass that hit the fault; a probe has none. A pass already
// cancelled pauses nothing, and the pause cancels every pass before it writes, so none can write
// after it. Its own write declines if another verb took the record meanwhile — a user pause
// outranks an automatic one.
export async function pauseMount(mount, status, reason, { gen = null } = {}) {
  const key = mirrorKey(mount.spaceId, mount.shareId)
  if (gen !== null && loops.stopped(key, gen)) return
  const at = loops.invalidate(key)
  mount.enabled = false
  mount.status = status
  // Durable, like the status itself: the reason is what the folder screen names the fault by, and
  // an event-only reason left the strip generic after every reload.
  mount.lastError = reason ?? null
  // Carry the Set and the collision map: a pause cancels the pass, so this write is what persists
  // whatever it landed. Both come from the mirror state, where a pass records them as it goes; the
  // rest is derived from the record as it is NOW.
  const written = await mutateForeignMount(mount.spaceId, mount.shareId, (m) => (loops.stopped(key, at) ? null : {
    ...m,
    enabled: false,
    status,
    lastError: reason ?? null,
    ...state.syncFields(mount),
  }))
  if (!written) return
  // Symmetry with the user-pause path (setForeignEnabled(false)): stop the poll loop so an
  // auto-paused mount doesn't keep a live interval and its in-flight fetch is cancelled.
  stopForeignLoop(mount.spaceId, mount.shareId)
  await syncMirrorRecord(mount.spaceId, mount.shareId, () => setMirrorState(mount.spaceId, mount.shareId, MIRROR_STATE.PAUSED))
  emitStatus(mount.spaceId, mount.shareId, status, reason ? { error: reason } : null)
}

// Pause the mount for a local I/O failure (overlay materializeOverlayFile write path). Returns
// true if it paused — the caller then stops; false leaves the error for generic handling. The
// fault→status decision is shared with the owner side; stopping the loop is ours, because a
// mirror's pause really does stop it.
export async function pauseMountForIoError(mount, err, { gen }) {
  const fault = faultFromError(err)
  if (fault) { await pauseMount(mount, fault.status, fault.code, { gen }); return true }
  if (err?.code === 'ENOENT' && !fs.existsSync(mount.mountPath)) { await pauseMount(mount, STATUS_MOUNT_GONE, null, { gen }); return true }
  return false
}

// A mirror's INITIAL scan failing is not a pause: the poll loop still runs, and the first tick
// that walks the catalog closes the status. So it records the fault without touching `enabled` —
// which is what keeps it out of the auto-pause resume gate. `gen` is the scan's generation: a scan
// cancelled by a pause, relocate or unmount records nothing (null), or a fault status over a user
// pause would make the mount read auto-paused.
export async function recordMirrorScanFault(spaceId, shareId, err, { gen }) {
  const code = classifyLocalIoFault(err)
  const status = statusForFaultCode(code)
  const key = mirrorKey(spaceId, shareId)
  const written = await mutateForeignMount(spaceId, shareId, (m) =>
    (loops.stopped(key, gen) ? null : { ...m, status, lastError: code }))
  if (!written) return null
  emitStatus(spaceId, shareId, status, { error: code })
  return status
}

/** @internal */
export function isAutoPaused(mount) {
  return !!mount && mount.enabled === false && isAutoPauseStatus(mount.status)
}

// Probe-driven twin of pauseMountForIoError for a mount whose local path vanished while the
// poll loop was idle: nothing touched the destination, so no I/O error ever classified the
// fault and the durable status stayed a stale 'active' that a refresh/boot would resurrect.
// No-ops for a user pause, an already-applied auto-pause, or a path that is actually present.
export async function autoPauseForeignMountGone(spaceId, shareId) {
  const mount = await getForeignMount(spaceId, shareId)
  if (!mount || mount.enabled === false) return false
  if (mountRootAvailable(mount.mountPath)) return false
  await pauseMount(mount, STATUS_MOUNT_GONE)
  return true
}

// Level-triggered recovery for an auto-paused mirror: the local target returned, the disk
// was freed, or a permission was fixed. Re-enables via the canonical enable path, which drives an
// immediate materialize through the serialized tick (not a bare initial scan) so it can't race the
// poll loop and can't leave a trailing status:'active'; if the fault still holds, that tick's
// write re-pauses it. A user pause and a still-missing path are left untouched.
export async function resumeAutoPausedForeignMount(spaceId, shareId) {
  const mount = await getForeignMount(spaceId, shareId)
  if (!isAutoPaused(mount)) return false
  if (!mountRootAvailable(mount.mountPath)) return false
  await setForeignEnabled(spaceId, shareId, true)
  return true
}
