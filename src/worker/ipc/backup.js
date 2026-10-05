// @ts-check
// The local backup's surface: its status, setting it up (the folder and the recovery key together),
// the key it keeps, the prompts it raises, and a run on request. While a restore is catching up the
// service waits, and the status says so; before the service has started it reads as not set up.

/** @import { WorkerIpc } from '../../shared/core/ipc.js' */
/** @import { BackupStatus } from '../../shared/contract/responses.js' */
/** @import { Backup } from '../backup-service.js' */
import { requireHost } from '../../shared/core/client-trust.js'
import { AppError } from '../../shared/core/errors.js'
import { CODES } from '../../shared/contract/errors.js'
import { getBackupConfig } from '../../shared/core/runtime-config.js'

/** @type {BackupStatus} */
const OFF = Object.freeze({
  folder: null, repoId: null, state: 'off', lastSuccessAt: null, lastSnapshot: null, lastError: null, suspect: null,
  key: Object.freeze({ createdAt: null, inFolder: false, checkedAt: null, secondCopyAt: null, reminders: true }), prompt: null, stale: false, verdict: null, verdictReason: null,
})

/** @param {Backup | null} backup @param {boolean} paused @returns {Backup} */
function service(backup, paused) {
  if (!backup) throw new AppError(CODES.NOT_FOUND, paused ? 'the local backup waits for the restore to finish' : 'the local backup is not running')
  return backup
}

// The backup can start after boot (when a restore's last hold is released), so each request asks
// for the current one.
/**
 * @param {WorkerIpc} ipc
 * @param {{ backup: () => Backup | null, paused: () => boolean, openRecovery: (text: string, passphrase: string) => Promise<{ masterSecret: Uint8Array }> }} deps
 */
export function registerBackup(ipc, { backup: current, paused: isPaused, openRecovery }) {
  const live = () => service(current(), isPaused())

  ipc.handle('backup:status', async () => {
    const backup = current()
    if (backup) return backup.status()
    if (!isPaused()) return OFF
    const { folder, repoId } = getBackupConfig()
    return { ...OFF, folder, repoId, state: 'paused' }
  })

  ipc.handle('backup:configure', async ({ folder }, ctx) => {
    requireHost(ctx.client, 'only the host may choose the backup folder')
    return live().configure(folder)
  })

  ipc.handle('backup:setup', async ({ folder, passphrase }, ctx) => {
    requireHost(ctx.client, 'only the host may set up the backup')
    return live().setUp(folder, passphrase)
  })

  ipc.handle('backup:turn-off', async (_msg, ctx) => {
    requireHost(ctx.client, 'only the host may turn the backup off')
    return live().configure(null)
  })

  ipc.handle('backup:run', async (_msg, ctx) => {
    requireHost(ctx.client, 'only the host may start a backup')
    return live().run('manual')
  })

  ipc.handle('backup:new-key', async ({ passphrase }, ctx) => {
    requireHost(ctx.client, 'only the host may replace the recovery key')
    return live().newKey(passphrase)
  })

  ipc.handle('backup:check-key', async ({ passphrase }, ctx) => {
    requireHost(ctx.client, 'only the host may check the recovery passphrase')
    return live().checkKey(passphrase, openRecovery)
  })

  ipc.handle('backup:key-file', async (_msg, ctx) => {
    requireHost(ctx.client, 'only the host may export the recovery key')
    return live().keyFile()
  })

  ipc.handle('backup:key-copied', async (_msg, ctx) => {
    requireHost(ctx.client, 'only the host may record a saved key')
    return live().keyCopied()
  })

  ipc.handle('backup:reminders', async ({ enabled }, ctx) => {
    requireHost(ctx.client, 'only the host may change the passphrase reminders')
    return live().setReminders(enabled)
  })

  ipc.handle('backup:prompt', async ({ prompt, action }, ctx) => {
    requireHost(ctx.client, 'only the host may answer a backup prompt')
    return live().answerPrompt(prompt, action)
  })
}
