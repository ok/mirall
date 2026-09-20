// Settings, storage and feature flags. The download-folder setter is the one that carries a rule:
// the global root is the effective root of every space that never overrode it.

import { createVerbosePolicy } from '../../shared/core/verbose-policy.js'
import {
  setVerbose,
  setDownloadFolder,
  setBandwidthLimits,
  isOverlayEnabled,
  isInPlaceFilesEnabled,
} from '../../shared/core/runtime-config.js'
import { daemonPaths } from '../../shared/contract/paths.js'
import { getStorageInfo } from '../../shared/storage/storage.js'
import { validateDownloadFolderAgainstMounts } from '../../shared/folders/mount-validate.js'

export function registerSettings(ipc, { mounts, publishDownloadRoots }) {
  const verbose = createVerbosePolicy({ apply: setVerbose })
  ipc.onClientDisconnect((client) => verbose.release(client.id))

  // Re-probing, rather than returning the cached set, is what makes a second call worth making:
  // every unavailable root is re-checked so the banner can appear at once rather than next tick.
  ipc.handle('downloads:roots-status', async () => {
    mounts.probeDownloadRoots()
    return daemonPaths({ unavailable: mounts.unavailableRoots })
  })

  ipc.handle('storage:info', async () => daemonPaths(await getStorageInfo()))

  ipc.handle('settings:set-download-folder', async (msg) => {
    // Same mount-overlap rejection as a per-space folder: pointing the global root into a folder
    // the user shares or mirrors publishes their downloads to peers just as surely.
    const folder = await validateDownloadFolderAgainstMounts(msg?.folder)
    setDownloadFolder(folder)
    publishDownloadRoots()
    return { ok: true }
  })

  // The limiters read their rate per call, so this reaches in-flight transfers with no
  // further plumbing.
  ipc.handle('settings:set-bandwidth', async (msg) => {
    setBandwidthLimits({ downloadKBps: msg?.downloadKBps, uploadKBps: msg?.uploadKBps })
    return { ok: true }
  })

  ipc.handle('features:get', async () => ({ overlay: isOverlayEnabled(), inPlaceFiles: isInPlaceFilesEnabled() }))

  // Live verbose-logging toggle, driven from the renderer dev console (window.mirall.verbose).
  // The logger reads the config on every call, so flipping it here takes effect with no relaunch.
  // The reply is the EFFECTIVE state, not the requested one: another client may still want it on.
  ipc.handle('setVerbose', async (msg, ctx) => ({ verbose: verbose.set(ctx.client.id, !!msg.verbose) }))
}
