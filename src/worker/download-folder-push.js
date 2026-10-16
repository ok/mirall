// @ts-check
// A request that names a download folder has it checked before anything runs, and makes it the
// space's only once the request is accepted (download-folder-choice.js), so a refused request
// changes nothing. Every client hears what changed, even when a later step fails: the spaces list
// when the space's folder moved, the settings when the recent list did, and main whenever the
// folders Reveal may open grew.

/** @import { WorkerIpc } from '../shared/core/ipc.js' */
import { validateDownloadFolderAgainstMounts } from '../shared/folders/mount-validate.js'
import { moveSpaceDownloadFolder, pushRecentDownloadFolder } from '../shared/transfer/download-folder-choice.js'
import { getProfile } from '../shared/spaces/profile.js'
import { Scope } from '../shared/contract/scope.js'
import { slimSpaces } from './space-projection.js'

/** @typedef {ReturnType<typeof createFolderChooser>} FolderChooser */

/** @param {{ ipc: WorkerIpc, publishRevealRoots: () => void }} deps */
export function createFolderChooser({ ipc, publishRevealRoots }) {
  /** @param {{ spaceChanged: boolean, recentChanged: boolean }} changed */
  async function announce({ spaceChanged, recentChanged }) {
    if (spaceChanged || recentChanged) publishRevealRoots()
    if (recentChanged) ipc.emit('event:reconcile', { scope: Scope.settings() })
    if (spaceChanged) ipc.emit('event:state', { spaces: await slimSpaces(await getProfile()) })
  }

  /** @param {string} spaceId @param {string} folder @returns {Promise<{ spaceChanged: boolean }>} */
  async function commit(spaceId, folder) {
    const changed = { spaceChanged: false, recentChanged: false }
    try {
      changed.spaceChanged = await moveSpaceDownloadFolder(spaceId, folder)
      changed.recentChanged = await pushRecentDownloadFolder(folder)
    } finally {
      await announce(changed)
    }
    return { spaceChanged: changed.spaceChanged }
  }

  return {
    // The folder a request names, normalized and checked against every mount: a download inside a
    // shared folder would be shared back. No folder named stays none.
    /** @param {string | null | undefined} folder @returns {Promise<string | undefined>} */
    validate: async (folder) => (typeof folder === 'string' && folder ? await validateDownloadFolderAgainstMounts(folder) : undefined),
    commit,
    // A download the backend answered without throwing commits the folder it named, and its answer
    // says when that moved the space. A mirrored folder downloads nothing and moves nothing.
    /**
     * @template {{ folderChanged?: true }} R
     * @param {string} spaceId @param {string | undefined} folder @param {R} res @returns {Promise<R>}
     */
    async commitDownload(spaceId, folder, res) {
      if (!folder || 'mirrored' in res) return res
      const { spaceChanged } = await commit(spaceId, folder)
      return spaceChanged ? { ...res, folderChanged: true } : res
    },
  }
}
