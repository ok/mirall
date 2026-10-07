// @ts-check
// Restoring from a backup folder: the snapshots its key can open, and one of them staged to
// replace this device's data when the worker restarts. Offered where a recovery key is — a locked
// identity, or one nobody has used yet — and never over an identity in use. The old installation is
// taken to be gone: its lease is cleared so this device can keep backing up into the same folder.

/** @import { WorkerIpc } from '../../shared/core/ipc.js' */
/** @import { Logger } from '../../shared/core/logger.js' */
/** @import { IdentityLockCode } from '../../shared/contract/errors.js' */
import fs from 'bare-fs'
import { requireHost } from '../../shared/core/client-trust.js'
import { wipeSecret } from '../../shared/core/identity-recovery.js'
import { sealPendingAdoption } from '../../shared/core/identity.js'
import { requestRestore, stagingPath, cancelPendingRestore } from '../../shared/core/identity-adopt.js'
import { unlockProviderFor } from '../../shared/core/unlock-provider.js'
import { openBackup, listRestorable, stageRestore } from '../../shared/storage/backup/restore.js'
import { FolderTarget } from '../../shared/storage/backup/folder-target.js'
import { readFolderKey } from '../../shared/storage/backup/folder-key.js'
import { peekRepo } from '../../shared/storage/backup/repo.js'
import { MAIN_REQUEST_FRAME, MAIN_REQUEST } from '../../shared/contract/main-requests.js'
import { AppError } from '../../shared/core/errors.js'
import { CODES } from '../../shared/contract/errors.js'
import { isUnclaimed } from './identity.js'

/** @param {string} folder */
function isFolder(folder) {
  try {
    return fs.statSync(folder).isDirectory()
  } catch {
    return false
  }
}

/**
 * @param {WorkerIpc} ipc
 * @param {{ storagePath: string, identityKEK: string | null | undefined, log: Logger, lockedBy: IdentityLockCode | null, openRecovery: (text: string, passphrase: string) => Promise<{ masterSecret: Uint8Array }> }} deps
 */
export function registerBackupRestore(ipc, { storagePath, identityKEK, log, lockedBy, openRecovery }) {
  // One restore at a time: they share the staging folder.
  let queue = Promise.resolve()

  async function assertAllowed() {
    if (!lockedBy && !(await isUnclaimed())) throw new AppError(CODES.NOT_AUTHORIZED, 'a backup is restored only over a locked or unused identity')
  }

  /** @param {string} folder @returns {Promise<string>} */
  async function keyContent(folder) {
    const target = new FolderTarget(folder)
    await target.ready()
    const found = await readFolderKey(target)
    if (!found) throw new AppError(CODES.BACKUP_KEY_MISSING, 'backup: this folder keeps no key')
    return found.content
  }

  /** @param {string} folder @param {string} snapshot @param {Uint8Array} masterSecret */
  async function restore(folder, snapshot, masterSecret) {
    cancelPendingRestore(storagePath)
    const repo = await openBackup(folder, masterSecret)
    const { hold, settings } = await stageRestore(repo, snapshot, stagingPath(storagePath))
    await repo.clearLeases()
    // Checked again: the staging can take long, and the identity may have been put to use meanwhile.
    await assertAllowed()
    await sealPendingAdoption({ storagePath, provider: unlockProviderFor({ identityKEK }), masterSecret })
    await requestRestore(storagePath, { hold })
    ipc.emit(MAIN_REQUEST_FRAME, { command: MAIN_REQUEST.BACKUP_REMEMBER, args: { folder, repoId: repo.repoId } })
    log.info('backup: snapshot', snapshot, 'staged; the worker restarts to put it in place')
    return settings
  }

  // Before any passphrase: is there a backup in this folder, does it keep a key, and how recent is it.
  // A folder that exists but holds no backup says so instead of reading as offline.
  ipc.handle('backup:peek', async ({ folder }, ctx) => {
    requireHost(ctx.client, 'only the host may read a backup')
    await assertAllowed()
    const target = new FolderTarget(folder)
    const { backup, lastBackupAt } = await peekRepo(target)
    if (!backup) {
      if (!isFolder(folder)) throw new AppError(CODES.BACKUP_TARGET_OFFLINE, 'backup folder: not a folder')
      return { backup: false, keyCreatedAt: null, lastBackupAt: null }
    }
    const key = await readFolderKey(target)
    return { backup: true, keyCreatedAt: key?.createdAt ?? null, lastBackupAt }
  })

  ipc.handle('backup:inspect', async ({ folder, passphrase }, ctx) => {
    requireHost(ctx.client, 'only the host may read a backup')
    await assertAllowed()
    const { masterSecret } = await openRecovery(await keyContent(folder), passphrase)
    try {
      return { snapshots: await listRestorable(await openBackup(folder, masterSecret)) }
    } finally {
      wipeSecret(masterSecret)
    }
  })

  ipc.handle('backup:restore', async ({ folder, snapshot, passphrase }, ctx) => {
    requireHost(ctx.client, 'only the host may restore a backup')
    await assertAllowed()
    const { masterSecret } = await openRecovery(await keyContent(folder), passphrase)
    const turn = queue.then(() => restore(folder, snapshot, masterSecret))
    queue = turn.then(() => {}, () => {})
    try {
      return /** @type {const} */ ({ ok: true, settings: await turn })
    } catch (err) {
      // A restore that failed part-way leaves nothing for the next boot to apply.
      cancelPendingRestore(storagePath)
      throw err
    } finally {
      wipeSecret(masterSecret)
    }
  })
}
