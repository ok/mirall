// @ts-check
// The identity's own surface: whether this worker could open it and whether a restore is still
// catching up, a recovery key sealed under the user's passphrase, adopting a key over a locked or
// unused identity, and setting a locked or restoring one aside. The plaintext master secret never
// crosses this boundary — a passphrase goes in and sealed text comes out. These handlers are the
// only ones a locked worker serves (with the worker-process ones).

/** @import { WorkerIpc } from '../../shared/core/ipc.js' */
/** @import { Logger } from '../../shared/core/logger.js' */
/** @import { IdentityLockCode } from '../../shared/contract/errors.js' */
/** @import { RestoreProgress } from '../../shared/contract/responses.js' */
import { requireHost } from '../../shared/core/client-trust.js'
import { assertPassphrase, wipeSecret } from '../../shared/core/identity-recovery.js'
import { sealMasterSecret, sealPendingAdoption, storageHoldsIdentity } from '../../shared/core/identity.js'
import { setAsideLockedData } from '../../shared/core/identity-set-aside.js'
import { requestSetAside, cancelPendingRestore } from '../../shared/core/identity-adopt.js'
import { writeRestoreHold, profileHeld, PROFILE_BEE } from '../../shared/core/restore-hold.js'
import { getProfile } from '../../shared/spaces/profile.js'
import { listSpaces } from '../../shared/spaces/space.js'
import { unlockProviderFor } from '../../shared/core/unlock-provider.js'
import { sealRecoveryKey } from '../../shared/core/store.js'
import { AppError } from '../../shared/core/errors.js'
import { CODES } from '../../shared/contract/errors.js'

// An identity nobody has used yet — no profile, no spaces — is all a fresh install holds, so a key
// may replace it.
export async function isUnclaimed() {
  return !profileHeld() && (await getProfile()) === null && (await listSpaces()).length === 0
}

/**
 * @param {WorkerIpc} ipc
 * @param {{ storagePath: string, identityKEK: string | null | undefined, log: Logger, lockedBy: IdentityLockCode | null, openRecovery: (text: string, passphrase: string) => Promise<{ masterSecret: Uint8Array }>, restoreStatus?: () => RestoreProgress | null }} deps
 */
export function registerIdentity(ipc, { storagePath, identityKEK, log, lockedBy, openRecovery, restoreStatus = () => null }) {

  ipc.handle('identity:status', () => ({ locked: lockedBy !== null, code: lockedBy, restore: restoreStatus() }))

  ipc.handle('identity:export-recovery', async ({ passphrase }, ctx) => {
    requireHost(ctx.client, 'only the host may export the recovery key')
    assertPassphrase(passphrase)
    const createdAt = new Date().toISOString()
    const content = await sealRecoveryKey(passphrase, { createdAt })
    return { fileName: `mirall-recovery-${createdAt.slice(0, 10)}.mirallkey`, content }
  })

  ipc.handle('identity:import-recovery', async ({ content, passphrase, replace }, ctx) => {
    requireHost(ctx.client, 'only the host may import a recovery key')
    // A key replaces a locked identity, or one nobody has used yet. Adopting it over an identity in use
    // would fork what peers hold of either.
    if (!lockedBy && !(await isUnclaimed())) throw new AppError(CODES.NOT_AUTHORIZED, 'a recovery key is adopted only over a locked or unused identity')
    const opened = await openRecovery(content, passphrase)
    try {
      const provider = unlockProviderFor({ identityKEK })
      if (!lockedBy) {
        cancelPendingRestore(storagePath)
        await sealPendingAdoption({ storagePath, provider, masterSecret: opened.masterSecret })
        log.info('identity: recovery key adopted; the next worker sets the unused identity aside and opens it')
        return /** @type {const} */ ({ ok: true })
      }
      const { hasCores, holdsProfile } = await storageHoldsIdentity(storagePath, opened.masterSecret)
      if (hasCores && !holdsProfile) {
        if (!replace) return /** @type {const} */ ({ ok: false, mismatch: true })
        // The other identity's data cannot be opened under this key (its content-key vault would
        // stop the next boot), so it is set aside as Start fresh would, then the key is adopted.
        log.warn('identity: replaced data set aside in', setAsideLockedData(storagePath))
      }
      // Held even over this identity's own data: that copy may be older than what peers hold. Written
      // before the envelope, so a crash between the two leaves a hold that only delays writes, never
      // an adopted identity whose profile is free to be written.
      await writeRestoreHold(storagePath, [PROFILE_BEE])
      await sealMasterSecret({ storagePath, provider, masterSecret: opened.masterSecret })
      log.info('identity: recovery key adopted; the worker restarts to open it')
      return /** @type {const} */ ({ ok: true })
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
    if (!restoreStatus()) throw new AppError(CODES.NOT_AUTHORIZED, 'only a locked or restoring identity is set aside')
    requestSetAside(storagePath)
    log.warn('identity: the restore is set aside when the worker restarts')
    return { folder: null }
  })
}
