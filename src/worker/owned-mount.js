// Everything owned-folder:mount does once the share exists and the path has been validated.
// Takes the validation result rather than the raw path so the composed create-and-mount, which
// has to validate before the share exists, does not run it twice. The entry builds one of these
// and hands it to both callers, so the two paths cannot drift.

import { AppError } from '../shared/core/errors.js'
import { CODES } from '../shared/contract/errors.js'
import { MOUNT_STATUS } from '../shared/contract/statuses.js'
import { MAIN_REQUEST_FRAME, MAIN_REQUEST } from '../shared/contract/main-requests.js'
import { TARGET_KIND } from '../shared/contract/audit-kinds.js'
import { getSpace } from '../shared/spaces/space.js'
import { DEFAULT_IGNORE } from '../shared/folders/path-keys.js'
import { countFolderFiles, initialPublishScan } from '../shared/folders/owned-folders.js'
import { exceedsShareFileLimit, shareFileLimitMessage } from '../shared/folders/share-limits.js'
import { mountRootAvailable } from '../shared/folders/publish-service.js'
import { createOwnedMount } from '../shared/folders/mount-store.js'
import { record } from '../shared/audit/audit-log.js'
import { selfActor, targetRef } from '../shared/audit/audit-record.js'
import { spaceRefOf } from './audit-refs.js'

export function createOwnedMounter({ ipc, mounts }) {
  return async function mountOwnedShare({ spaceId, share, validated, ignore: requestedIgnore }) {
    const shareId = share.id
    const { mountPath, advisories } = validated
    const ignore = requestedIgnore && requestedIgnore.length > 0 ? requestedIgnore : DEFAULT_IGNORE

    // The admission gate. This is the CREATE path (the renderer's add-folder wizard is its only
    // caller) — relocate, the periodic reconcile and the watcher's publishAdd are deliberately NOT
    // gated, so a share that grows past the limit keeps publishing instead of breaking on restart.
    // The modal blocks first; this is the authoritative check.
    const fileCount = await countFolderFiles(mountPath, ignore)
    if (exceedsShareFileLimit(fileCount)) {
      throw new AppError(CODES.SHARE_FILE_LIMIT, shareFileLimitMessage(fileCount))
    }

    const mount = {
      spaceId,
      shareId,
      mountPath,
      ignore,
      createdAt: Date.now(),
    }
    await createOwnedMount(mount)
    // Seed the probe baseline so the first mount-point tick doesn't read this brand-new mount as a
    // gone→present transition (which would otherwise run against an unseeded key).
    mounts.lastMountPointStatus.set('owned-folder:' + shareId, mountRootAvailable(mountPath))
    await mounts.recordActivity(spaceId, shareId, MOUNT_STATUS.SCANNING)

    ipc.emit(MAIN_REQUEST_FRAME, {
      command: MAIN_REQUEST.OWNED_FOLDER_START_WATCHER,
      args: { shareId, mountPath, ignore },
    })

    mounts.settleScanStatus(initialPublishScan(spaceId, shareId, mountPath, ignore), spaceId, shareId)
      .then(async (result) => {
        // Cancelled mid-index: whoever cancelled (delete, relocate, leave, pause) owns the
        // follow-up; re-arming the reconcile here would resurrect it for a share that is gone.
        if (result?.cancelled) return
        if (result && !result.skipped) ipc.emit('event:owned-folder-scan-completed', { spaceId, shareId, ...result })
        // One row for the deliberate act, carrying the totals from the initial scan. The recurring
        // reconcile deliberately records nothing — it is machine churn, not a user action.
        record('share.mounted', {
          actor: selfActor(),
          space: spaceRefOf(await getSpace(spaceId)),
          target: targetRef(TARGET_KIND.SHARE, shareId, share?.name ?? null),
          subject: { fileCount: result?.totalOnDisk ?? null, uploaded: result?.uploaded ?? null, mountPath },
        })
        mounts.schedulePeriodicReconcile(spaceId, shareId, mountPath, ignore)
      })

    return { mount, advisories }
  }
}
