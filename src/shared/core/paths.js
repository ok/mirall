// Resolves download destinations. Two roots are in play: the GLOBAL root (the OS
// downloads folder, or the user's override in Storage Settings) injected by Electron
// main at worker spawn, and an optional PER-SPACE override stored on the local space
// record. The per-space map is hydrated by the caller from listSpaces() so this module
// never reads the bee itself, which keeps core/ free of a dependency on spaces/.
import os from 'bare-os'
import path from 'bare-path'
import { getRuntimeConfig } from './runtime-config.js'
import { pathContains } from '../folders/path-keys.js'

const spaceRoots = new Map()

function foldCase() {
  const platform = os.platform()
  return platform === 'darwin' || platform === 'win32'
}

export function getGlobalDownloadDir() {
  return getRuntimeConfig().downloadFolder || path.join(os.homedir(), 'Downloads')
}

// Callers that genuinely want the global root must call getGlobalDownloadDir()
// explicitly — a forgotten spaceId here would silently mis-scope a download claim.
export function getDownloadDir(spaceId) {
  if (spaceId && spaceRoots.has(spaceId)) return spaceRoots.get(spaceId)
  return getGlobalDownloadDir()
}

export function hydrateDownloadRoots(spaces) {
  spaceRoots.clear()
  for (const space of spaces || []) {
    if (typeof space?.downloadFolder === 'string' && space.downloadFolder.length > 0) {
      spaceRoots.set(space.spaceId, space.downloadFolder)
    }
  }
}

export function setSpaceDownloadRoot(spaceId, folder) {
  if (typeof folder === 'string' && folder.length > 0) spaceRoots.set(spaceId, folder)
  else spaceRoots.delete(spaceId)
}

export function forgetSpaceDownloadRoot(spaceId) {
  spaceRoots.delete(spaceId)
}

// The space's EXPLICIT override, or null when it just follows the global root. The
// difference is load-bearing for download claims: an override is a promise about where
// this space's files live (so a copy outside it is out of scope), while following the
// global root promises nothing about any particular folder — see verifyOnDevice.
export function getSpaceDownloadOverride(spaceId) {
  return (spaceId && spaceRoots.get(spaceId)) || null
}

// Every distinct root in use. The boot partial sweep and mount validation must each
// consider all of them, not just the global one.
export function listDownloadRoots() {
  return [...new Set([getGlobalDownloadDir(), ...spaceRoots.values()])]
}

export function isInsideDownloadDir(absPath, root) {
  return pathContains(root, absPath, path.sep, foldCase())
}
