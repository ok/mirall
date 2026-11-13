// @ts-check
// File events a test delivers itself, standing in for the back end's own watchers. Registered only
// when the `testFileWatchersOff` lever has turned those watchers off, so a worker in a product run
// serves none of these and no local client can feed it a file event. Each reaches the same data
// layer handler the watchers hand their events to, and answers once the event has been handled.

/** @import { WorkerIpc } from '../../shared/core/ipc.js' */
/** @import { Logger } from '../../shared/core/logger.js' */
import { errorMessage } from '../../shared/core/errors.js'
import { handleOwnedFsEvent } from '../../shared/folders/owned-watcher.js'
import { handleMirrorFsEvent } from '../../shared/folders/mirror-watcher.js'
import { handleLooseFsEvent } from '../../shared/transfer/overlay/loose-publish.js'

/** @param {WorkerIpc} ipc @param {{ log: Logger }} deps */
export function registerTestFsEvents(ipc, { log }) {
  ipc.handle('event:owned-folder-fs-event', async (msg) => {
    try {
      await handleOwnedFsEvent({ shareId: msg.shareId, action: msg.action, relPath: msg.relPath, absPath: msg.absPath })
    } catch (err) {
      log.warn('owned-folder fs event failed:', errorMessage(err))
    }
    return { ok: true }
  })

  ipc.handle('event:foreign-folder-fs-event', async (msg) => {
    try { await handleMirrorFsEvent({ spaceId: msg.spaceId, shareId: msg.shareId, action: msg.action, relPath: msg.relPath }) }
    catch (err) { log.warn('foreign-folder fs event failed:', errorMessage(err)) }
    return { ok: true }
  })

  ipc.handle('event:loose-file-fs-event', async (msg) => {
    try {
      await handleLooseFsEvent({ spaceId: msg.spaceId, absPath: msg.absPath, action: msg.action })
    } catch (err) {
      log.warn('loose-file fs event failed:', errorMessage(err))
    }
    return { ok: true }
  })
}
