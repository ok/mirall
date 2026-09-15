import { initFolderPublish } from '../../src/shared/transfer/backends/overlay/folder-publish.js'
import { initFolderDownloads } from '../../src/shared/transfer/backends/overlay/folder-downloads.js'
import { initLoosePublish } from '../../src/shared/transfer/backends/overlay/loose-publish.js'
import { initLooseDownloads } from '../../src/shared/transfer/backends/overlay/loose-downloads.js'
import { initPublishProgress } from '../../src/shared/transfer/backends/overlay/publish-progress.js'

// Points every overlay emitter at one fake ipc, the way OverlayBackend._open does for the worker's.
export function initOverlayIpc(ipc) {
  initFolderPublish({ ipc })
  initFolderDownloads({ ipc })
  initPublishProgress({ emit: (name, payload) => ipc.emit(name, payload), broadcast: null })
}

// The loose twin: both loose sides on one fake ipc.
export function initLooseIpc(ipc) {
  initLoosePublish({ ipc })
  initLooseDownloads({ ipc })
}
