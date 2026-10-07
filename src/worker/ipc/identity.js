// @ts-check
// The identity's own surface: whether this worker could open it and whether a restore is still
// catching up, unlocking a locked identity with the key its backup folder keeps, and setting a locked
// or restoring one aside. The plaintext master secret never crosses this boundary — a passphrase goes
// in, nothing secret comes out. These handlers are the
// only ones a locked worker serves (with the worker-process ones).

/** @import { WorkerIpc } from '../../shared/core/ipc.js' */
/** @import { Logger } from '../../shared/core/logger.js' */
/** @import { IdentityLockCode } from '../../shared/contract/errors.js' */
/** @import { RestoreStatus } from '../../shared/contract/responses.js' */
import { requireHost } from '../../shared/core/client-trust.js'
import { wipeSecret } from '../../shared/core/identity-recovery.js'
import { sealMasterSecret, storageHoldsIdentity } from '../../shared/core/identity.js'
import { setAsideLockedData } from '../../shared/core/identity-set-aside.js'
import { requestSetAside } from '../../shared/core/identity-adopt.js'
import { writeRestoreHold, profileHeld, PROFILE_BEE } from '../../shared/core/restore-hold.js'
import { getProfile } from '../../shared/spaces/profile.js'
import { listSpaces } from '../../shared/spaces/space.js'
import { unlockProviderFor } from '../../shared/core/unlock-provider.js'
import { FolderTarget } from '../../shared/storage/backup/folder-target.js'
import { readFolderKey } from '../../shared/storage/backup/folder-key.js'
import { AppError } from '../../shared/core/errors.js'
import { CODES } from '../../shared/contract/errors.js'

// An identity nobody has used yet — no profile, no spaces — is all a fresh install holds, so a restore
// may replace it.
export async function isUnclaimed() {
  return !profileHeld() && (await getProfile()) === null && (await listSpaces()).length === 0
}

/**
 * @param {WorkerIpc} ipc
 * @param {{ storagePath: string, identityKEK: string | null | undefined, log: Logger, lockedBy: IdentityLockCode | null, openRecovery: (text: string, passphrase: string) => Promise<{ masterSecret: Uint8Array }>, restoreStatus?: () => RestoreStatus | null }} deps
 */
export function registerIdentity(ipc, { storagePath, identityKEK, log, lockedBy, openRecovery, restoreStatus = () => null }) {

  ipc.handle('identity:status', () => ({ locked: lockedBy !== null, code: lockedBy, restore: restoreStatus() }))

  // On a locked device the backup folder's key opens this device's own data in place: the data stays,
  // newer than any backup, and is held until the people the user shares with confirm it. Data that is
  // not this identity's is left to a restore, which sets it aside.
  ipc.handle('identity:unlock-from-backup', async ({ folder, passphrase }, ctx) => {
    requireHost(ctx.client, 'only the host may unlock with a backup')
    if (!lockedBy) throw new AppError(CODES.NOT_AUTHORIZED, 'only a locked identity is unlocked with a backup')
    const target = new FolderTarget(folder)
    await target.ready()
    const found = await readFolderKey(target)
    if (!found) throw new AppError(CODES.BACKUP_KEY_MISSING, 'backup: this folder keeps no key')
    const opened = await openRecovery(found.content, passphrase)
    try {
      const { holdsProfile } = await storageHoldsIdentity(storagePath, opened.masterSecret)
      if (!holdsProfile) return { unlocked: false }
      // Held even over this identity's own data: that copy may be older than what peers hold. Written
      // before the envelope, so a crash between the two leaves a hold that only delays writes, never
      // an adopted identity whose profile is free to be written.
      await writeRestoreHold(storagePath, [PROFILE_BEE], 'key')
      await sealMasterSecret({ storagePath, provider: unlockProviderFor({ identityKEK }), masterSecret: opened.masterSecret })
      log.info('identity: unlocked with the backup key; the worker restarts to open it')
      return { unlocked: true }
    } finally {
      wipeSecret(opened.masterSecret)
    }
  })

  ipc.handle('identity:set-aside', (_msg, ctx) => {
    requireHost(ctx.client, 'only the host may set the identity aside')
    if (lockedBy) {
      const folder = setAsideLockedData(storagePath)
      log.warn('identity: locked data set aside in', folder)
      return { folder }
    }
    if (!restoreStatus()?.profile) throw new AppError(CODES.NOT_AUTHORIZED, 'only a locked or restoring identity is set aside')
    requestSetAside(storagePath)
    log.warn('identity: the restore is set aside when the worker restarts')
    return { folder: null }
  })
}
