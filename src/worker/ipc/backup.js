// @ts-check
// The local backup's surface: its status, the folder it writes to, and a run on request. With the
// feature off there is no service, and the status says so; while a restore is catching up the service
// waits, and the status says that instead.

/** @import { WorkerIpc } from '../../shared/core/ipc.js' */
/** @import { BackupStatus } from '../../shared/contract/responses.js' */
/** @import { Backup } from '../backup-service.js' */
import { requireHost } from '../../shared/core/client-trust.js'
import { AppError } from '../../shared/core/errors.js'
import { CODES } from '../../shared/contract/errors.js'
import { getBackupConfig } from '../../shared/core/runtime-config.js'

/** @type {BackupStatus} */
const OFF = Object.freeze({ enabled: false, folder: null, repoId: null, state: 'off', lastSuccessAt: null, lastSnapshot: null, lastError: null, suspect: null })

/** @param {Backup | null} backup @param {boolean} paused @returns {Backup} */
function service(backup, paused) {
  if (!backup) throw new AppError(CODES.NOT_FOUND, paused ? 'the local backup waits for the restore to finish' : 'the local backup is not enabled')
  return backup
}

// The backup can start after boot (when a restore's last hold is released), so each request asks
// for the current one.
/** @param {WorkerIpc} ipc @param {{ backup: () => Backup | null, paused: () => boolean }} deps */
export function registerBackup(ipc, { backup: current, paused: isPaused }) {
  ipc.handle('backup:status', () => {
    const backup = current()
    if (backup) return backup.view()
    if (!isPaused()) return OFF
    const { folder, repoId } = getBackupConfig()
    return { ...OFF, enabled: true, folder, repoId, state: 'paused' }
  })

  ipc.handle('backup:configure', async ({ folder }, ctx) => {
    requireHost(ctx.client, 'only the host may choose the backup folder')
    return service(current(), isPaused()).configure(folder)
  })

  ipc.handle('backup:turn-off', async (_msg, ctx) => {
    requireHost(ctx.client, 'only the host may turn the backup off')
    return service(current(), isPaused()).configure(null)
  })

  ipc.handle('backup:run', async (_msg, ctx) => {
    requireHost(ctx.client, 'only the host may start a backup')
    return service(current(), isPaused()).run('manual')
  })
}
