// What the unreachable-folder toast does as the spaces' folders and the unavailable set change.
// Only a transition acts: the same fault seen again on a re-probe changes nothing, so a toast the
// user dismissed stays dismissed, while a fresh failed download against the folder (`faultSeq`)
// names it again. Several spaces losing their folder at once — one ejected disk — name the first
// and count the rest. A space still waiting for approval is never named: its screen has no way to
// change the folder, which is where the toast's action leads.
import { sameFolder } from './download-folders.js'
/** @import { HostPaths } from './download-folders.js' */

/** @typedef {{ spaceId: string, name: string, downloadFolder: string, status?: string }} FolderSpace */
/** @typedef {{ key: string, folder: string | null }} FolderToastState */
/**
 * @typedef {{ kind: 'show', spaceId: string, space: string, more: number, folder: string }
 *   | { kind: 'dismiss' } | { kind: 'restored' }} FolderToastAction
 */

/**
 * @param {{ previous: FolderToastState | null, spaces: readonly FolderSpace[], unavailable: readonly string[], faultSeq: number, host: HostPaths }} args
 * @returns {{ state: FolderToastState, action: FolderToastAction | null }}
 */
export function folderToastDecision({ previous, spaces, unavailable, faultSeq, host }) {
  const offline = (/** @type {string} */ folder) => unavailable.some((u) => sameFolder(u, folder, host))
  const [first, ...rest] = spaces.filter((s) => s.status !== 'pending' && offline(s.downloadFolder))
  if (first) {
    const key = JSON.stringify([first.spaceId, first.downloadFolder, rest.length, faultSeq])
    const state = { key, folder: first.downloadFolder }
    if (previous?.key === key) return { state, action: null }
    return { state, action: { kind: 'show', spaceId: first.spaceId, space: first.name, more: rest.length, folder: first.downloadFolder } }
  }
  /** @type {FolderToastState} */
  const state = { key: '', folder: null }
  // No toast up: the first probe of a healthy session is not a recovery.
  if (!previous?.folder) return { state, action: null }
  // No space downloads to the folder the toast named any more. It came back, or the space moved
  // off it or was left while it is still gone: then the fault concerns nobody and nothing returned.
  return { state, action: { kind: offline(previous.folder) ? 'dismiss' : 'restored' } }
}
