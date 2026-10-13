import { initFolderPublish } from '../../src/shared/transfer/overlay/folder-publish.js'
import { initLoosePublish } from '../../src/shared/transfer/overlay/loose-publish.js'
import { initShareDownloads } from '../../src/shared/transfer/overlay/share-downloads.js'
import { initPublishProgress } from '../../src/shared/transfer/overlay/publish-progress.js'

// Points every overlay emitter at one fake ipc, the way OverlayBackend._open does for the worker's.
// Downloads of both kinds leave through share-downloads.js, so each helper wires it.
export function initOverlayIpc(ipc) {
  initFolderPublish({ ipc })
  initShareDownloads({ ipc })
  initPublishProgress({ emit: (name, payload) => ipc.emit(name, payload), broadcast: null })
}

// The loose twin: the loose publish side and the downloads on one fake ipc.
export function initLooseIpc(ipc) {
  initLoosePublish({ ipc })
  initShareDownloads({ ipc })
}
