// Where downloads land. Each space has its own folder, stored on its local record and mirrored here
// by the caller (this module never reads a bee). The app's folder only seeds a space when it is
// created or joined: nothing falls back to it while a space has a folder. Three sets answer three
// questions: the folders downloads go to next, the folders the Download-to menu offers, and every
// folder that holds a download or a partial.
import os from 'bare-os'
import path from 'bare-path'
import { getRuntimeConfig } from './runtime-config.js'
import { pathContains, pathEquals } from '../contract/paths.js'

const spaceFolders = new Map()
let recentFolders = []
const landedFolders = new Set()
let onRootsChanged = null

// Whether this host's filesystems match names regardless of case, as macOS and Windows do by
// default. Every path comparison in the worker reads it, and so does every client the host's paths
// are sent to (the settings view's `caseFolds`).
/** @returns {boolean} */
export function hostFoldsCase() {
  const platform = os.platform()
  return platform === 'darwin' || platform === 'win32'
}

// A folder as it is stored and compared: absolute, and composed (NFC) on macOS, whose APIs hand a
// name back decomposed where Foundation or Finder created it — both spellings open the one folder.
/** @param {string} folder @returns {string} */
export function normalizeFolderPath(folder) {
  const resolved = path.resolve(folder)
  return os.platform() === 'darwin' ? resolved.normalize('NFC') : resolved
}

export function getNewSpaceDownloadDir() {
  const { downloadFolder, defaultDownloadFolder } = getRuntimeConfig()
  return normalizeFolderPath(downloadFolder || defaultDownloadFolder || path.join(os.homedir(), 'Downloads'))
}

// A space with no folder yet (a record from before the folder was per space, until boot's backfill)
// answers the seed, so no caller ever gets null.
/** @param {string | null | undefined} spaceId @returns {string} */
export function getDownloadDir(spaceId) {
  return (spaceId && spaceFolders.get(spaceId)) || getNewSpaceDownloadDir()
}

export function hydrateDownloadRoots(spaces) {
  spaceFolders.clear()
  for (const space of spaces || []) setSpaceDownloadRoot(space.spaceId, space.downloadFolder)
}

export function setSpaceDownloadRoot(spaceId, folder) {
  if (typeof folder === 'string' && folder.length > 0) spaceFolders.set(spaceId, folder)
  else spaceFolders.delete(spaceId)
}

export function forgetSpaceDownloadRoot(spaceId) {
  spaceFolders.delete(spaceId)
}

/** @param {string[]} folders */
export function setRecentDownloadFolders(folders) {
  recentFolders = [...folders]
}

// Called with no argument when the landed folders change, so the reveal allowlist follows.
export function setDownloadRootsListener(fn) {
  onRootsChanged = fn
}

function addLandedFolders(dirs) {
  let grew = false
  for (const dir of dirs) {
    if (typeof dir !== 'string' || !dir || landedFolders.has(dir)) continue
    landedFolders.add(dir)
    grew = true
  }
  return grew
}

// Replaces the set with every folder the store's pending rows and claims name, which boot reads, so
// each boot starts from its own store.
/** @param {Iterable<string>} dirs */
export function setLandedFolders(dirs) {
  landedFolders.clear()
  addLandedFolders(dirs)
  onRootsChanged?.()
}

// A folder something landed or started in. Notifies once per call however many folders are new.
/** @param {Iterable<string>} dirs */
export function noteLandedFolders(dirs) {
  if (addLandedFolders(dirs)) onRootsChanged?.()
}

const unique = (list) => [...new Set(list)]

// The folders a download goes to next: each space's folder and the one new spaces start in. A mount
// may not overlap one, in either direction.
export function listCurrentDownloadFolders() {
  return unique([getNewSpaceDownloadDir(), ...spaceFolders.values()])
}

// The folders the Download-to menu offers, which the drive probe watches.
export function listOfferedDownloadFolders() {
  return unique([...listCurrentDownloadFolders(), ...recentFolders])
}

// Every folder that holds a download or a partial: Reveal may open them and the boot sweep reads them.
export function listDownloadRoots() {
  return unique([...listOfferedDownloadFolders(), ...landedFolders])
}

export function isInsideDownloadDir(absPath, root) {
  return pathContains(root, absPath, path.sep, hostFoldsCase())
}

/** @param {string} a @param {string} b */
export function isSameFolder(a, b) {
  return pathEquals(a, b, path.sep, hostFoldsCase())
}
