// The scan previews both mount wizards run before committing, and the cancel that stops one.
// Owned and foreign previews share this module because they share the abort registry: a preview
// is cancelled by id, and the id alone does not say which kind of scan is running behind it.

import { DEFAULT_IGNORE } from '../../shared/folders/path-keys.js'
import { previewInitialPublishScan } from '../../shared/folders/owned-preview.js'
import { previewMaterializeScan } from '../../shared/folders/foreign-preview.js'

export function registerFolderPreview(ipc) {
  const previewAborts = new Map()

  // Two request names, one function: the names are the wire contract (contract/requests.js).
  const cancelPreview = async (msg) => {
    const sig = previewAborts.get(msg.previewId)
    if (sig) sig.aborted = true
    return { ok: true }
  }
  ipc.handle('owned-folder:cancel-preview', cancelPreview)
  ipc.handle('foreign-folder:cancel-preview', cancelPreview)

  // A preview with no id cannot be cancelled and reports no progress, so it takes no slot.
  const withSignal = async (previewId, run) => {
    const signal = previewId ? { aborted: false } : null
    if (previewId) previewAborts.set(previewId, signal)
    try {
      return await run(signal)
    } finally {
      if (previewId) previewAborts.delete(previewId)
    }
  }

  ipc.handle('owned-folder:preview', async (msg) => {
    const ignore = msg.ignore || DEFAULT_IGNORE
    const shareId = msg.shareId && msg.shareId !== 'preview' ? msg.shareId : null
    const previewId = msg.previewId || null
    return await withSignal(previewId, (signal) =>
      previewInitialPublishScan(msg.spaceId, shareId, msg.mountPath, ignore, {
        signal,
        onProgress: previewId
          ? (p) => ipc.emit('event:owned-folder-preview-progress', { previewId, ...p })
          : null,
      }))
  })

  ipc.handle('foreign-folder:preview', async (msg) => {
    const previewId = msg.previewId || null
    return await withSignal(previewId, (signal) =>
      previewMaterializeScan(msg.spaceId, msg.ownerKey, msg.shareId, msg.mountPath, {
        signal,
        onProgress: previewId
          ? (p) => ipc.emit('event:foreign-folder-preview-progress', { previewId, ...p })
          : null,
      }))
  })
}
