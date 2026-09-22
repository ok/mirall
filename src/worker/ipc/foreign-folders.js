// Foreign folders — a share someone else owns, mirrored into a folder on this disk. The mount
// record and the mirror record live in two stores, which is why removal runs under an intent.

import { daemonPaths } from '../../shared/contract/paths.js'
import { AppError } from '../../shared/core/errors.js'
import { CODES } from '../../shared/contract/errors.js'
import { MOUNT_STATUS } from '../../shared/contract/statuses.js'
import { getSpace } from '../../shared/spaces/space.js'
import { validateMountPath } from '../../shared/folders/mount-validate.js'
import { publishMirror } from '../../shared/folders/mirror-records.js'
import { startForeignLoop, scanForeignMount, setForeignEnabled, relocateForeignFolder, unmountForeignFolder } from '../../shared/folders/foreign-verbs.js'
import { insertForeignMount, getForeignMount, listForeignMounts } from '../../shared/folders/mount-store.js'
import { record } from '../../shared/audit/audit-log.js'
import { selfActor, targetRef } from '../../shared/audit/audit-record.js'
import { TARGET_KIND } from '../../shared/contract/audit-kinds.js'
import { spaceRefOf, shareNameOrNull } from '../audit-refs.js'

export function registerForeignFolders(ipc, { log, intents }) {
  // One place, so a new return path cannot forget it: a mount record crossing the wire says whose
  // disk its mountPath is on. The stored record is untouched — a persisted 'daemon' would be a lie
  // the day the store is moved to another machine.
  const wire = (mount) => (mount ? daemonPaths(mount) : mount)

  ipc.handle('foreign-folder:validate', async (msg) => {
    return daemonPaths(await validateMountPath(msg.mountPath, 'foreign-folder', { shareId: msg.shareId }))
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
    // A share has one mirror. The same request again — a double submit — answers with the mount it
    // made; another folder for the same share is a relocate, not a second mount, and replacing the
    // record here would leave the first mount's passes writing into it.
    const existing = await insertForeignMount(mount)
    if (existing) {
      if (existing.mountPath === mountPath) return { mount: wire(existing), advisories }
      throw new AppError(CODES.MOUNT_OVERLAPS, 'This share is already mirrored to another folder')
    }
    ipc.emit('event:foreign-folder-mount-status', { spaceId: msg.spaceId, shareId: msg.shareId, status: MOUNT_STATUS.SCANNING })
    try { await publishMirror(msg.spaceId, msg.shareId, { state: 'syncing' }) }
    catch (err) { log.warn('mirror record publish failed:', msg.shareId, '-', err.message) }
    ipc.emit('event:mirrors-updated', { spaceId: msg.spaceId, shareId: msg.shareId })

    // The loop is armed before the scan, as at boot: its first tick coalesces behind the scan, a
    // scan that rejects still leaves a running loop to re-derive from, and a pause or unmount during
    // the scan stops a loop that exists rather than racing one that does not yet.
    startForeignLoop(mount)
    scanForeignMount(mount)

    record('mirror.created', {
      actor: selfActor(),
      space: spaceRefOf(await getSpace(msg.spaceId)),
      target: targetRef(TARGET_KIND.SHARE, msg.shareId, await shareNameOrNull(msg.spaceId, msg.ownerKey, msg.shareId)),
      subject: { mountPath: mount.mountPath, ownerKey: msg.ownerKey },
    })
    return { mount: wire(mount), advisories }
  })

  ipc.handle('foreign-folder:get', async (msg) => {
    return wire(await getForeignMount(msg.spaceId, msg.shareId))
  })

  ipc.handle('foreign-folder:set-enabled', async (msg) => {
    return wire(await setForeignEnabled(msg.spaceId, msg.shareId, !!msg.enabled))
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
    if (mountPath === mount.mountPath) return { mount: wire(mount), advisories }
    const next = await relocateForeignFolder(msg.spaceId, msg.shareId, mountPath)
    record('mirror.relocated', {
      actor: selfActor(),
      space: spaceRefOf(await getSpace(msg.spaceId)),
      target: targetRef(TARGET_KIND.SHARE, msg.shareId, await shareNameOrNull(msg.spaceId, mount.ownerKey, msg.shareId)),
      subject: { mountPath, previousMountPath: mount.mountPath },
    })
    return { mount: wire(next), advisories }
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
    return (await listForeignMounts()).map(wire)
  })
}
