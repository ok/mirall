// What a mirror reports outward: the mount-status event the renderer renders, and the replicated
// mirror-participation record the space's other members read. The IPC handle for the whole mirror
// side lives here — the root installs it at open and clears it at close — so every leaf reports
// through the same slot instead of carrying its own.
import { MIRROR_STATE } from '../contract/statuses.js'
import { createLogger } from '../core/logger.js'

const log = createLogger('mirror-signals')

let ipc = null

export function initMirrorSignals(_ipc) {
  ipc = _ipc
}

export function resetMirrorSignals() {
  ipc = null
}

export function emitMirrorEvent(event, payload) {
  ipc?.emit(event, payload)
}

export function emitStatus(spaceId, shareId, status, extra) {
  emitMirrorEvent('event:foreign-folder-mount-status', { spaceId, shareId, status, ...(extra || {}) })
}

// Keep the replicated mirror-participation record in step with a mount lifecycle change, then poke
// the local mirror views. A record-write failure must not break the mount operation itself.
export async function syncMirrorRecord(spaceId, shareId, op) {
  let changed = false
  try { changed = await op() } catch (err) { log.warn('mirror record update failed:', shareId, '-', err.message) }
  if (changed) emitMirrorEvent('event:mirrors-updated', { spaceId, shareId })
}

// The one place a materialize pass reports its terminal sync state: 'synced' once every catalog
// entry is present locally, else 'syncing'. Written through the pass's writer.
export function settleMirrorSyncState(writer, mount, allPresent) {
  return syncMirrorRecord(mount.spaceId, mount.shareId,
    () => writer.setMirrorState(allPresent ? MIRROR_STATE.SYNCED : MIRROR_STATE.SYNCING))
}
