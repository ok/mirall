// @ts-check
// The identity's own surface: whether this worker could open it, a recovery key sealed under the
// user's passphrase, and, while it is locked, adopting a key or setting the identity aside. The plaintext master secret
// never crosses this boundary — a passphrase goes in and sealed text comes out. These handlers are
// the only ones a locked worker serves (with the worker-process ones).

/** @import { WorkerIpc } from '../../shared/core/ipc.js' */
/** @import { Logger } from '../../shared/core/logger.js' */
/** @import { IdentityLockCode } from '../../shared/contract/errors.js' */
import { requireHost } from '../../shared/core/client-trust.js'
import { assertPassphrase, openRecoveryFile, wipeSecret } from '../../shared/core/identity-recovery.js'
import { sealMasterSecret, storageHoldsIdentity } from '../../shared/core/identity.js'
import { setAsideLockedData } from '../../shared/core/identity-set-aside.js'
import { unlockProviderFor } from '../../shared/core/unlock-provider.js'
import { sealRecoveryKey } from '../../shared/core/store.js'
import { AppError } from '../../shared/core/errors.js'
import { CODES } from '../../shared/contract/errors.js'

// Each wrong passphrase doubles the wait before the next attempt, to a ceiling. The Argon2 cost is
// what stands against an attacker holding the file; this only slows guessing through the app.
const RETRY_BASE_MS = 1000
const RETRY_CEILING_MS = 30000
/** @param {number} failures */
const retryDelay = (failures) => (failures === 0 ? 0 : Math.min(RETRY_CEILING_MS, RETRY_BASE_MS * 2 ** (failures - 1)))

// Whether this device's data already belongs to the key's identity, or holds nothing worth keeping,
// asked of the store the locked worker's failed boot closed.
/** @param {Uint8Array} masterSecret @param {string} storagePath */
async function holdsOrEmpty(masterSecret, storagePath) {
  const { hasCores, holdsProfile } = await storageHoldsIdentity(storagePath, masterSecret)
  return !hasCores || holdsProfile
}

/**
 * @param {WorkerIpc} ipc
 * @param {{ storagePath: string, identityKEK: string | null | undefined, log: Logger, lockedBy: IdentityLockCode | null }} deps
 */
export function registerIdentity(ipc, { storagePath, identityKEK, log, lockedBy }) {
  let failures = 0

  ipc.handle('identity:status', () => ({ locked: lockedBy !== null, code: lockedBy }))

  ipc.handle('identity:export-recovery', async ({ passphrase }, ctx) => {
    requireHost(ctx.client, 'only the host may export the recovery key')
    assertPassphrase(passphrase)
    const createdAt = new Date().toISOString()
    const content = await sealRecoveryKey(passphrase, { createdAt })
    return { fileName: `mirall-recovery-${createdAt.slice(0, 10)}.mirallkey`, content }
  })

  ipc.handle('identity:import-recovery', async ({ content, passphrase, replace }, ctx) => {
    requireHost(ctx.client, 'only the host may import a recovery key')
    // Only a locked identity is replaced. Adopting a key over a running one — or into a fresh install,
    // whose empty profile would then be written from block 0 of a core peers already hold — forks it.
    if (!lockedBy) throw new AppError(CODES.NOT_AUTHORIZED, 'a recovery key is adopted only while the identity is locked')
    const wait = retryDelay(failures)
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    let opened
    try {
      opened = await openRecoveryFile(content, passphrase)
    } catch (err) {
      if (err instanceof AppError && err.code === CODES.WRONG_PASSPHRASE) failures++
      throw err
    }
    failures = 0
    try {
      if (!(await holdsOrEmpty(opened.masterSecret, storagePath))) {
        if (!replace) return /** @type {const} */ ({ ok: false, mismatch: true })
        // The other identity's data cannot be opened under this key (its content-key vault would
        // stop the next boot), so it is set aside as Start fresh would, then the key is adopted.
        log.warn('identity: replaced data set aside in', setAsideLockedData(storagePath))
      }
      await sealMasterSecret({ storagePath, provider: unlockProviderFor({ identityKEK }), masterSecret: opened.masterSecret })
      log.info('identity: recovery key adopted; the worker restarts to open it')
      return /** @type {const} */ ({ ok: true })
    } finally {
      wipeSecret(opened.masterSecret)
    }
  })

  ipc.handle('identity:set-aside', (_msg, ctx) => {
    requireHost(ctx.client, 'only the host may set the identity aside')
    if (!lockedBy) throw new AppError(CODES.NOT_AUTHORIZED, 'only an identity this device cannot open is set aside')
    const folder = setAsideLockedData(storagePath)
    log.warn('identity: locked data set aside in', folder)
    return { folder }
  })
}
