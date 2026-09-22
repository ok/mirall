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

// A pass that hit the fault pauses through its own writer; a probe, which has no pass, writes
// directly. The write declines when the record is no longer the one the fault was seen on: already
// disabled (a user pause outranks an automatic one) or pointed at another folder by a relocate.
// Otherwise it invalidates the generation under the lock, ahead of any pass write queued behind it.
// Resolves whether it paused.
export async function pauseMount(mount, status, reason, { writer = null } = {}) {
  const { spaceId, shareId } = mount
  const mutate = writer ? writer.mutate : (apply) => mutateForeignMount(spaceId, shareId, apply)
  const written = await mutate((m) => {
    if (m.enabled === false || m.mountPath !== mount.mountPath) return null
    loops.invalidate(mirrorKey(spaceId, shareId))
    return {
      ...m,
      enabled: false,
      status,
      // Durable, like the status itself: the reason is what the folder screen names the fault by,
      // and an event-only reason left the strip generic after every reload.
      lastError: reason ?? null,
      // Carry the Set and the collision map: a pause cancels the pass, so this write is what
      // persists whatever it landed. Both come from the mirror state, where a pass records them.
      ...state.syncFields(mount),
    }
  })
  if (!written) return false
  Object.assign(mount, { enabled: false, status, lastError: reason ?? null })
  // Symmetry with the user-pause path (setForeignEnabled(false)): stop the poll loop so an
  // auto-paused mount doesn't keep a live interval and its in-flight fetch is cancelled.
  stopForeignLoop(spaceId, shareId)
  await syncMirrorRecord(spaceId, shareId, () => setMirrorState(spaceId, shareId, MIRROR_STATE.PAUSED))
  emitStatus(spaceId, shareId, status, reason ? { error: reason } : null)
  return true
}

// Pause the mount for a local I/O failure (overlay materializeOverlayFile write path). Returns
// true if it was a fault this classifies — the caller then stops; false leaves the error for
// generic handling. The fault→status decision is shared with the owner side; stopping the loop is
// ours, because a mirror's pause really does stop it.
export async function pauseMountForIoError(mount, err, { writer }) {
  const fault = faultFromError(err)
  if (fault) { await pauseMount(mount, fault.status, fault.code, { writer }); return true }
  if (err?.code === 'ENOENT' && !fs.existsSync(mount.mountPath)) { await pauseMount(mount, STATUS_MOUNT_GONE, null, { writer }); return true }
  return false
}

// A mirror's INITIAL scan failing is not a pause: the poll loop still runs, and the first tick
// that walks the catalog closes the status. So it records the fault without touching `enabled` —
// which is what keeps it out of the auto-pause resume gate. Resolves null when the scan's writer
// declined: a fault status over a user pause would make the mount read auto-paused.
export async function recordMirrorScanFault(writer, { spaceId, shareId }, err) {
  const code = classifyLocalIoFault(err)
  const status = statusForFaultCode(code)
  if (!(await writer.patch({ status, lastError: code }))) return null
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
  return await pauseMount(mount, STATUS_MOUNT_GONE)
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
