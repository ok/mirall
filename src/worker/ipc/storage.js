// @ts-check
// Storage accounting: the read, an on-demand measurement of replaced records, and the worker half of
// "Free up". A measurement pokes every open Storage screen, whoever asked for it.

/** @import { WorkerIpc } from '../../shared/core/ipc.js' */
import { daemonPaths } from '../../shared/contract/paths.js'
import { getStorageInfo } from '../../shared/storage/storage.js'
import { freeUpStorage, measureHistory } from '../../shared/storage/storage-history.js'

/** @param {WorkerIpc} ipc */
export function registerStorage(ipc) {
  ipc.handle('storage:info', async () => daemonPaths(await getStorageInfo()))
  ipc.handle('storage:measure', async () => {
    await measureHistory()
    ipc.emit('event:storage-updated', {})
    return daemonPaths(await getStorageInfo())
  })
  ipc.handle('storage:free-up', async () => await freeUpStorage())
}
