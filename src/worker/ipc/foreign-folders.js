// Foreign folders — a share someone else owns, mirrored into a folder on this disk. The mount
// record and the mirror record live in two stores, which is why removal runs under an intent.

import { AppError } from '../../shared/core/errors.js'
import { CODES } from '../../shared/contract/errors.js'
import { MOUNT_STATUS } from '../../shared/contract/statuses.js'
import { getSpace } from '../../shared/spaces/space.js'
import { validateMountPath } from '../../shared/folders/mount-validate.js'
import { publishMirror } from '../../shared/folders/mirror-records.js'
import {
  initialMaterializeScan,
  recordMirrorScanFault,
  startForeignLoop,
  setForeignEnabled,
  relocateForeignFolder,
  unmountForeignFolder,
} from '../../shared/folders/foreign-folders.js'
import { createForeignMount as persistForeignMount, getForeignMount, listForeignMounts } from '../../shared/folders/mount-store.js'
import { record } from '../../shared/audit/audit-log.js'
import { selfActor, targetRef } from '../../shared/audit/audit-record.js'
import { TARGET_KIND } from '../../shared/contract/audit-kinds.js'
import { spaceRefOf, shareNameOrNull } from '../audit-refs.js'

export function registerForeignFolders(ipc, { log, intents }) {
  ipc.handle('foreign-folder:validate', async (msg) => {
    return await validateMountPath(msg.mountPath, 'foreign-folder', { shareId: msg.shareId })
  })

  ipc.handle('foreign-folder:mount', async (msg) => {
    const { mountPath, advisories } = await validateMountPath(msg.mountPath, 'foreign-folder', { shareId: msg.shareId })
    const mount = {
      spaceId: msg.spaceId,
      shareId: msg.shareId,
      ownerKey: msg.ownerKey,
      mountPath,
      enabled: true,
      attachedAt: Date.now(),
      status: MOUNT_STATUS.SCANNING,
    }
    await persistForeignMount(mount)
    ipc.emit('event:foreign-folder-mount-status', { spaceId: msg.spaceId, shareId: msg.shareId, status: MOUNT_STATUS.SCANNING })
    try { await publishMirror(msg.spaceId, msg.shareId, { state: 'syncing' }) }
    catch (err) { log.warn('mirror record publish failed:', msg.shareId, '-', err.message) }
    ipc.emit('event:mirrors-updated', { spaceId: msg.spaceId, shareId: msg.shareId })

    // Start the poll loop regardless of the initial scan's outcome: a scan that rejects must still
    // leave a running loop so the record re-derives from 'syncing' instead of stranding there.
    initialMaterializeScan(mount)
      .catch(async (err) => {
        log.warn('mirror initial scan failed:', err.message)
        // Through the shared recorder, so the fault is durable and typed (a code, not a message).
        await recordMirrorScanFault(msg.spaceId, msg.shareId, err)
          .catch((e) => log.debug('mirror scan fault record failed:', msg.shareId, '-', e.message))
      })
      .finally(() => { startForeignLoop(mount) })

    record('mirror.created', {
      actor: selfActor(),
      space: spaceRefOf(await getSpace(msg.spaceId)),
      target: targetRef(TARGET_KIND.SHARE, msg.shareId, await shareNameOrNull(msg.spaceId, msg.ownerKey, msg.shareId)),
      subject: { mountPath: mount.mountPath, ownerKey: msg.ownerKey },
    })
    return { mount, advisories }
  })

  ipc.handle('foreign-folder:get', async (msg) => {
    return await getForeignMount(msg.spaceId, msg.shareId)
  })

  ipc.handle('foreign-folder:set-enabled', async (msg) => {
    return await setForeignEnabled(msg.spaceId, msg.shareId, !!msg.enabled)
  })

  // Re-point a mirror at a new folder on disk. The bytes already written stay where they are — this
  // moves the mount, it does not move files — so the honest reading is: files the user moved with it
  // are recognised on the next pass (materialisation stats the destination and compares the share's
  // hash), and anything missing is fetched again.
  ipc.handle('foreign-folder:relocate', async (msg) => {
    const mount = await getForeignMount(msg.spaceId, msg.shareId)
    if (!mount) throw new AppError(CODES.MOUNT_NOT_ON_DEVICE, 'Mount not found')
    const { mountPath, advisories } = await validateMountPath(msg.mountPath, 'foreign-folder', { shareId: msg.shareId })
    // Validation normalises the path, so the comparison belongs after it: re-pointing a mount at
    // where it already is would drop the synced set and re-verify the whole folder for nothing.
    if (mountPath === mount.mountPath) return { mount, advisories }
    const next = await relocateForeignFolder(msg.spaceId, msg.shareId, mountPath)
    record('mirror.relocated', {
      actor: selfActor(),
      space: spaceRefOf(await getSpace(msg.spaceId)),
      target: targetRef(TARGET_KIND.SHARE, msg.shareId, await shareNameOrNull(msg.spaceId, mount.ownerKey, msg.shareId)),
      subject: { mountPath, previousMountPath: mount.mountPath },
    })
    return { mount: next, advisories }
  })

  ipc.handle('foreign-folder:unmount', async (msg) => {
    const mount = await getForeignMount(msg.spaceId, msg.shareId)
    // The unmount drops the mount record and the mirror record in two stores; a crash between them
    // leaves a mirror loop armed against a mount that is already gone.
    const intentId = await intents.beginOrNull('foreign-unmount', { spaceId: msg.spaceId, shareId: msg.shareId })
    await unmountForeignFolder(msg.spaceId, msg.shareId)
    await intents.complete(intentId)
    record('mirror.removed', {
      actor: selfActor(),
      space: spaceRefOf(await getSpace(msg.spaceId)),
      target: targetRef(TARGET_KIND.SHARE, msg.shareId, await shareNameOrNull(msg.spaceId, mount?.ownerKey, msg.shareId)),
      subject: { mountPath: mount?.mountPath ?? null },
    })
    return { ok: true }
  })

  ipc.handle('foreign-folder:list-all', async () => {
    return await listForeignMounts()
  })
}
