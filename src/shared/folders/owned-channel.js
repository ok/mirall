// The publish service's 'folder' channel: how one owned-folder work item resolves against the
// mount it belongs to, and what publishing or retiring it means. Registered at import, because the
// service dispatches on a channel that must exist before the first item is enqueued.
//
// Every item re-derives its precondition from CURRENT state here, never from the facts it was
// enqueued with: an item can sit in the lane for minutes, and in that time the mount may have been
// paused, relocated or unplugged.
import { getOwnedMount } from './mount-store.js'
import { getContentBackend, isUnsupportedShare } from '../transfer/content-backends.js'
import { pathFromMount } from './path-guard.js'
import { registerPublishChannel, settleCatalog, mountRootAvailable, getPublishScheduler } from './publish-service.js'
import { OP, PRIORITY } from './work-item.js'
import { loadShare } from './owned-shares.js'
import { fileExactlyPresent, fileStatPresent } from './disk-presence.js'
import { makeServable } from '../transfer/backends/overlay/serve-registration.js'

// Injected by owned-folders.js: the channel is registered at import and the engine it belongs to
// does not exist until _open.
let state = null
let emit = () => {}
let onProgress = () => {}
let onFlush = () => {}

export function initOwnedChannel(d) {
  state = d.state
  emit = d.emit
  onProgress = d.onProgress
  onFlush = d.onFlush
}

registerPublishChannel('folder', {
  async resolve(item) {
    const mount = await getOwnedMount(item.spaceId, item.shareId)
    if (!mount) return { skip: 'skipped-unmounted' }
    // The watcher does not go through the diff: onFsEvent enqueues straight onto the scheduler on
    // the INTERACTIVE lane, so a file edited during a pause would publish past the scan's own gate.
    // Dropping it is the same recovery shape as skipped-root-gone — the resume scan re-derives it.
    if (mount.indexPaused) return { skip: 'skipped-index-paused' }
    // A missing root is ambiguous (unplugged, offline) and never a delete. When a root vanishes
    // the watcher emits one unlink per file, and every one of them lands here.
    if (!mountRootAvailable(mount.mountPath)) return { skip: 'skipped-root-gone' }
    const share = await loadShare(state, item.spaceId, item.shareId)
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
  onPublishFailed: (item, _ctx, err) => state?.recordFault(item.spaceId, item.shareId, err),
  onProgress: (spaceId, shareId) => onProgress(spaceId, shareId),
  onDrained: (spaceId, shareId) => {
    onFlush(spaceId, shareId)
    settleCatalog(spaceId).then(() => emit('event:share-files-updated', { spaceId, shareId }))
  },
  onSpaceIdle: (spaceId) => state?.forgetShares(spaceId),
  // Maintenance walks a share only while its root is a directory: a temporarily unavailable mount
  // must never read as an empty folder and mass-retire.
  async contentRoot({ spaceId, shareId }) {
    const mount = await getOwnedMount(spaceId, shareId)
    return mount?.mountPath && mountRootAvailable(mount.mountPath) ? mount.mountPath : null
  },
  // Exact-name presence, as the retire executor judges it. A relPath that escapes the mount is
  // catalog poison, not a file: absent, so the lane reclaims it.
  async presentAt({ root, relPath }) {
    try { return fileExactlyPresent(pathFromMount(root, relPath)) } catch { return false }
  },
  // Drift is the reconcile pass's job, not the rehydrate's: a hashed entry whose file is still
  // there is re-registered as it stands.
  async rehydrate({ root, spaceId, shareId, entry }) {
    if (!entry.contentHash) return
    const absPath = pathFromMount(root, entry.relPath)
    if (!fileStatPresent(absPath)) return
    await makeServable({ spaceId, shareId, relPath: entry.relPath, absPath, contentHash: entry.contentHash, size: entry.size })
  },
  // The lane's ticket resolves with a settlement and never rejects, so the outcome is read; a
  // cancel is the user stopping it, not a failure.
  async retireGone({ spaceId, shareId, relPath }) {
    const { settled } = getPublishScheduler().enqueue({ spaceId, shareId, relPath, op: OP.RETIRE, priority: PRIORITY.BULK })
    const s = await settled
    if (s?.outcome === 'failed') throw s.error ?? new Error('the publish runner refused it')
  },
})
