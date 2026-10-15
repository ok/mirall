// @ts-check
// Settings. The worker is the only writer of settings.json: every setter writes the file first,
// then patches the live config, then pokes every client to re-read. The download-folder setter
// carries a rule: the global root is the effective root of every space that never overrode it.

/** @import { WorkerIpc } from '../../shared/core/ipc.js' */
/** @import { WorkerRoot } from '../boot.js' */
import { createVerbosePolicy } from '../../shared/core/verbose-policy.js'
import {
  setVerbose,
  setDownloadFolder,
  setBandwidthLimits,
} from '../../shared/core/runtime-config.js'
import { getSettings, updateSettings } from '../../shared/core/settings-store.js'
import { getGlobalDownloadDir } from '../../shared/core/paths.js'
import { daemonPaths } from '../../shared/contract/paths.js'
import { Scope } from '../../shared/contract/scope.js'
import { validateDownloadFolderAgainstMounts } from '../../shared/folders/mount-validate.js'

/** @param {unknown} value */
function validCap(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

export function settingsView() {
  const { downloads, network, links } = getSettings()
  return {
    downloads: { folder: getGlobalDownloadDir(), isDefault: downloads.folder === null },
    network: { downloadKBps: network.downloadKBps, uploadKBps: network.uploadKBps, relayMode: network.relayMode, relay: network.relay },
    links: { baseUrl: links.baseUrl },
  }
}

/**
 * @param {WorkerIpc} ipc
 * @param {{ mounts: WorkerRoot['mounts'], publishDownloadRoots: () => void }} deps
 */
export function registerSettings(ipc, { mounts, publishDownloadRoots }) {
  const verbose = createVerbosePolicy({ apply: setVerbose })
  ipc.onClientDisconnect((client) => verbose.release(client.id))
  const poke = () => ipc.emit('event:reconcile', { scope: Scope.settings() })

  // Re-probing, rather than returning the cached set, is what makes a second call worth making:
  // every unavailable root is re-checked so the banner can appear at once rather than next tick.
  ipc.handle('downloads:roots-status', async () => {
    mounts.probeDownloadRoots()
    return daemonPaths({ unavailable: mounts.unavailableRoots })
  })

  ipc.handle('settings:get', async () => settingsView())

  // An omitted folder returns to the host's default. Same mount-overlap rejection as a per-space
  // folder: pointing the global root into a folder the user shares or mirrors publishes their
  // downloads to peers just as surely.
  ipc.handle('settings:set-download-folder', async (msg) => {
    const folder = msg?.folder ? await validateDownloadFolderAgainstMounts(msg.folder) : null
    await updateSettings((s) => { s.downloads.folder = folder; return s })
    setDownloadFolder(folder)
    publishDownloadRoots()
    poke()
    return settingsView()
  })

  // The limiters read their rate per call, so this reaches in-flight transfers with no
  // further plumbing. A direction that is omitted or corrupt keeps the cap the user last set.
  ipc.handle('settings:set-bandwidth', async (msg) => {
    const { network } = await updateSettings((s) => {
      s.network.downloadKBps = validCap(msg?.downloadKBps) ?? s.network.downloadKBps
      s.network.uploadKBps = validCap(msg?.uploadKBps) ?? s.network.uploadKBps
      return s
    })
    setBandwidthLimits({ downloadKBps: network.downloadKBps, uploadKBps: network.uploadKBps })
    poke()
    return settingsView()
  })

  // Live verbose-logging toggle, driven from the renderer dev console (window.mirall.verbose).
  // The logger reads the config on every call, so flipping it here takes effect with no relaunch.
  // The reply is the EFFECTIVE state, not the requested one: another client may still want it on.
  ipc.handle('setVerbose', async (msg, ctx) => ({ verbose: verbose.set(ctx.client.id, !!msg.verbose) }))
}
