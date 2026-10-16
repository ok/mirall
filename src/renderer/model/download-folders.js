// The Download-to menu's folders: the space's folder first (current), then every other folder of this
// device's recent list, each once. A folder on a drive that is not connected stays in its place,
// marked offline. A folder is named by its last segment and shown with the worker's home folder
// written as ~.
import { lastSegment, parentFolder, pathContains, pathEquals, shortenHome } from '../../shared/contract/paths.js'

/** @typedef {{ home: string, sep: string, caseFolds: boolean }} HostPaths */
/** @typedef {{ path: string, name: string, shown: string, current: boolean, offline: boolean }} FolderChoice */

/** @param {string} a @param {string} b @param {HostPaths} host */
export const sameFolder = (a, b, host) => pathEquals(a, b, host.sep, host.caseFolds)

/**
 * @param {{ path: string, current: boolean, unavailable: readonly string[], host: HostPaths }} args
 * @returns {FolderChoice}
 */
function folderChoice({ path, current, unavailable, host }) {
  return {
    path,
    name: lastSegment(path, host.sep),
    shown: shortenHome(path, host.home, host.sep, host.caseFolds),
    current,
    offline: unavailable.some((u) => sameFolder(u, path, host)),
  }
}

/**
 * @param {{ current: string, recent: readonly string[], unavailable: readonly string[], host: HostPaths }} args
 * @returns {FolderChoice[]}
 */
export function folderChoices({ current, recent, unavailable, host }) {
  const others = recent.filter((p) => !sameFolder(p, current, host))
  return [current, ...others].map((path, i) => folderChoice({ path, current: i === 0, unavailable, host }))
}

// The controls row's Downloads to: shown where something can be downloaded and, on the space screen
// (`offline` given), while the space's folder is on a drive that is not connected, so the way to
// pick another is on the screen the unreachable-folder toast opens even with nothing to download. A
// folder screen passes no `offline`: an own or mirrored folder never offers it. Hidden while
// selecting: the strip's split button names the folder.
/** @param {{ downloadable: boolean, selecting: boolean, offline?: boolean }} args */
export const downloadsToShown = ({ downloadable, selecting, offline = false }) => !selecting && (downloadable || offline)

// Where a row's copy is, when the row should say so: a downloaded copy outside the space's folder,
// or one on a drive that is not connected. Shown as the copy's own folder. Nothing is said before
// the worker's path rules are known: judged by another host's rules, a path reads wrong.
/**
 * @param {{ status: string, localPath: string | null }} row @param {string} folder @param {HostPaths | undefined} host
 * @returns {{ kind: 'elsewhere' | 'detached', shown: string } | null}
 */
export function copyPlace(row, folder, host) {
  if (!row.localPath || !host) return null
  const kind = row.status === 'detached' ? 'detached'
    : row.status === 'downloaded' && !pathContains(folder, row.localPath, host.sep, host.caseFolds) ? 'elsewhere'
      : null
  if (!kind) return null
  return { kind, shown: shortenHome(parentFolder(row.localPath, host.sep), host.home, host.sep, host.caseFolds) }
}
