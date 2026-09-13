// Owned folders — a folder on this disk published into a space. The watcher lives in the main
// process (Bare has no recursive watch), so its events arrive here as IPC rather than from a
// local watcher.

import { AppError } from '../../shared/core/errors.js'
import { CODES } from '../../shared/contract/errors.js'
import { MOUNT_STATUS } from '../../shared/contract/statuses.js'
import { MAIN_REQUEST_FRAME, MAIN_REQUEST } from '../../shared/contract/main-requests.js'
import { TARGET_KIND } from '../../shared/contract/audit-kinds.js'
import { getSpace } from '../../shared/spaces/space.js'
import { readOwnShares, tombstoneShare } from '../../shared/shares/shares.js'
import { validateMountPath } from '../../shared/folders/mount-validate.js'
import {
  handleFsEventFromMain,
  getIndexStatus,
  initialPublishScan,
  stopOwnedFolder,
} from '../../shared/folders/owned-folders.js'
import { mountRootAvailable } from '../../shared/folders/publish-runner.js'
import {
  getOwnedMount,
  patchOwnedMount,
  deleteOwnedMount,
  listOwnedMounts,
  listAllMounts,
} from '../../shared/folders/mount-store.js'
import { record } from '../../shared/audit/audit-log.js'
import { selfActor, targetRef } from '../../shared/audit/audit-record.js'
import { spaceRefOf } from '../audit-refs.js'

export function registerOwnedFolders(ipc, { log, mounts, intents, mountOwnedShare }) {
  ipc.handle('event:owned-folder-fs-event', async (msg) => {
    try {
      await handleFsEventFromMain(msg)
    } catch (err) {
      log.warn('owned-folder fs event failed:', err.message)
    }
  })

  ipc.handle('owned-folder:validate', async (msg) => {
    return await validateMountPath(msg.mountPath, 'owned-folder', { shareId: msg.shareId })
  })

  ipc.handle('owned-folder:mount', async (msg) => {
    const own = await readOwnShares(msg.spaceId)
    const share = own.find((s) => s.id === msg.shareId)
    if (!share) throw new AppError(CODES.SHARE_NOT_FOUND, 'Share not found')

    const validated = await validateMountPath(msg.mountPath, 'owned-folder', { shareId: msg.shareId })
    return await mountOwnedShare({ spaceId: msg.spaceId, share, validated, ignore: msg.ignore })
  })

  ipc.handle('owned-folder:get', async (msg) => {
    return await getOwnedMount(msg.spaceId, msg.shareId)
  })

  ipc.handle('owned-folder:index-status', async (msg) => {
    return getIndexStatus(msg.spaceId, msg.shareId)
  })

  // Pause the index: stop the burst AND the cadence, durably. Nothing resumes this but an explicit
  // resume — that is the whole vocabulary: a folder is running or the user paused it, and ending
  // it for good is Delete Folder.
  ipc.handle('owned-folder:pause-index', async (msg) => {
    return await mounts.pauseIndex(msg.spaceId, msg.shareId)
  })

  ipc.handle('owned-folder:resume-index', async (msg) => {
    return await mounts.resumeIndex(msg.spaceId, msg.shareId)
  })

  // Re-point an owned folder at a new on-disk location after the original source
  // was moved, renamed, or disconnected. The hash-based reconcile recognizes
  // unchanged content at the new path and uploads nothing, so mirror peers see
  // no churn — this is why relocate beats delete-and-re-add for recovery.
  ipc.handle('owned-folder:relocate', async (msg) => {
    const mount = await getOwnedMount(msg.spaceId, msg.shareId)
    if (!mount) throw new AppError(CODES.MOUNT_NOT_ON_DEVICE, 'Mount not found')

    const { mountPath, advisories } = await validateMountPath(msg.mountPath, 'owned-folder', { shareId: msg.shareId })

    mounts.cancelPeriodicReconcile(msg.spaceId, msg.shareId)
    // Queued items carry paths under the old root; the executor re-resolves the mount, but they
    // must not burn slots either.
    stopOwnedFolder(msg.spaceId, msg.shareId)
    ipc.emit(MAIN_REQUEST_FRAME, { command: MAIN_REQUEST.OWNED_FOLDER_STOP_WATCHER, args: { shareId: msg.shareId } })

    const previousMountPath = mount.mountPath
    // By patch, not by writing back the whole `mount` this handler read at the top: validateMountPath
    // runs in between and a concurrent probe or scan settle can have persisted a status against the
    // record since, which a stale whole-object write would silently drop.
    await patchOwnedMount(msg.spaceId, msg.shareId, { mountPath })
    mount.mountPath = mountPath
    mounts.lastMountPointStatus.set('owned-folder:' + msg.shareId, true)

    // Locate Folder clears the gone fault; a paused index is still paused, which the precedence
    // decides rather than this call site.
    await mounts.recordActivity(msg.spaceId, msg.shareId, MOUNT_STATUS.SCANNING)
    ipc.emit(MAIN_REQUEST_FRAME, {
      command: MAIN_REQUEST.OWNED_FOLDER_START_WATCHER,
      args: { shareId: msg.shareId, mountPath, ignore: mount.ignore },
    })

    // Relocate diffs by content hash (deep): the new path is typically a moved/copied tree whose
    // mtimes differ, but identical content must upload nothing so mirror peers see no churn. The fast
    // size+mtime diff misses on every fresh mtime and re-advertises each entry — and publishContent
    // advertises with a null hash before re-hashing, so every mirror re-downloads a tree that did not
    // change.
    //
    // The debt is recorded for BOTH branches, before either pass is armed: the flag is the durable
    // fact, a running pass is not. Locate Folder is not Resume, so a paused index stays paused at its
    // new path and owes the deep pass to its eventual resume; an ACTIVE index owes it to the pass
    // below, which runs in a floating promise a quit mid-walk can end.
    await patchOwnedMount(msg.spaceId, msg.shareId, { deepScanOwed: true })

    // Re-read: `mount` predates validateMountPath and two awaits, so a pause landing in between would
    // be missed and this would arm a pass the user had stopped.
    const current = await getOwnedMount(msg.spaceId, msg.shareId)
    if (!current?.indexPaused) {
      mounts.settleScanStatus(initialPublishScan(msg.spaceId, msg.shareId, mountPath, mount.ignore, { deep: true }), msg.spaceId, msg.shareId)
        .then(async (result) => {
          if (result?.cancelled) return
          // Cleared only by a pass that actually ran to completion. A cancelled, failed or skipped
          // pass leaves the debt standing, which is what makes the next runner take it.
          if (result && !result.skipped) {
            await patchOwnedMount(msg.spaceId, msg.shareId, { deepScanOwed: false })
            ipc.emit('event:owned-folder-scan-completed', { spaceId: msg.spaceId, shareId: msg.shareId, ...result })
          }
          mounts.schedulePeriodicReconcile(msg.spaceId, msg.shareId, mountPath, mount.ignore)
        })
    }

    record('share.relocated', {
      actor: selfActor(),
      space: spaceRefOf(await getSpace(msg.spaceId)),
      target: targetRef(TARGET_KIND.SHARE, msg.shareId, null),
      subject: { from: previousMountPath, to: mountPath },
    })
    return { mount, advisories }
  })

  ipc.handle('owned-folder:delete', async (msg) => {
    const own = await readOwnShares(msg.spaceId)
    const share = own.find((s) => s.id === msg.shareId)
    // An unknown share warns but does not stop: the teardown below is idempotent, and a delete is
    // most needed exactly when the record is already half-gone — a crash between the two writes, or a
    // repeated click. Refusing here would strand the mount, the watcher and the tombstone.
    if (!share) {
      log.warn('delete requested for unknown share:', msg.shareId)
    }

    // The two writes below land in different bees, so a crash between them leaves the share still
    // advertised with no mount behind it. Recorded first, cleared last; boot finishes the pair.
    const intentId = await intents.beginOrNull('owned-delete', { spaceId: msg.spaceId, shareId: msg.shareId })

    mounts.cancelPeriodicReconcile(msg.spaceId, msg.shareId)
    stopOwnedFolder(msg.spaceId, msg.shareId)
    ipc.emit(MAIN_REQUEST_FRAME, { command: MAIN_REQUEST.OWNED_FOLDER_STOP_WATCHER, args: { shareId: msg.shareId } })

    // Overlay keeps no per-share drive blobs to tombstone — the share record
    // tombstone below retires the catalog from every consumer's view.
    await deleteOwnedMount(msg.spaceId, msg.shareId)
    await tombstoneShare(msg.spaceId, msg.shareId)
    await intents.complete(intentId)
    record('share.deleted', {
      actor: selfActor(),
      space: spaceRefOf(await getSpace(msg.spaceId)),
      target: targetRef(TARGET_KIND.SHARE, msg.shareId, share?.name ?? null),
    })
    ipc.emit('event:shares-updated', { spaceId: msg.spaceId })
    ipc.emit('event:share-files-updated', { spaceId: msg.spaceId, shareId: msg.shareId })
    return { ok: true }
  })

  ipc.handle('owned-folder:list-all', async () => {
    const all = await listOwnedMounts()
    return all.map((m) => ({ ...m, mountPointMissing: !mountRootAvailable(m.mountPath) }))
  })

  ipc.handle('mounts:list-all', async () => {
    return await listAllMounts()
  })
}
