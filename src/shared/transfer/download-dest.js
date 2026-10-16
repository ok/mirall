import fs from 'bare-fs'
import path from 'bare-path'
import { nextFreeName } from '../folders/path-keys.js'
import { pathFromMount } from '../folders/path-guard.js'
import { isInsideDownloadDir } from '../core/paths.js'
import { PARTIAL_SUFFIX } from './partial-suffix.js'

/** @typedef {{ has: (abs: string) => boolean }} Reserved */
/** @type {Reserved} */
const NO_RESERVED = new Set()

// A name is taken by a final file OR an in-flight partial, so a fresh destination, a collision
// sibling and a conflict copy never land on the user's file or another transfer's orphan.
export function nameTakenAt(absPath) {
  return fs.existsSync(absPath) || fs.existsSync(absPath + PARTIAL_SUFFIX)
}

// What a transfer's partial already holds on the volume, for a preflight that credits a resume.
export function partialAllocatedBytes(finalPath) {
  try { return fs.statSync(finalPath + PARTIAL_SUFFIX).blocks * 512 || 0 } catch { return 0 }
}

// A destination relative to the download root. A bare name lands in the root; a path with folders
// is joined through pathFromMount, so a peer's relPath can never climb out of the root. Only the
// leaf takes a free name: the folders are the share's own. `reserved` holds destinations other
// transfers resolved but have not written yet, which the disk cannot answer for.
/** @param {string} root @param {string} rel @param {Reserved} [reserved] */
export function resolveDest(root, rel, reserved = NO_RESERVED) {
  const segments = rel.split('/')
  const leaf = segments.pop() ?? rel
  const dir = segments.length ? pathFromMount(root, segments.join('/')) : root
  const taken = (name) => {
    const abs = path.join(dir, name)
    return reserved.has(abs) || nameTakenAt(abs)
  }
  return path.join(dir, nextFreeName(leaf, taken))
}

// The destination for a transfer that may already have a pinned one. A pending row records
// `finalPath` at start, and the pin is reused while it sits under the folder the row lands in now
// (landingRoot): a row that moved to another folder re-resolves there and gives up the bytes in the
// old partial, which the boot sweep reclaims. A pin a file now sits at is re-resolved too: the
// receive only refuses to replace a file that appears during it, so a retry into the pin would take
// that file as its starting point and write over it. A pin another live transfer holds is not
// reusable either: two shares can carry one name, so a row keyed by that name may belong to a
// different owner's file that is being written now.
/** @param {string | null | undefined} prevFinalPath @param {string} root @param {Reserved} [reserved] @returns {string | null} */
export function pinnedDest(prevFinalPath, root, reserved = NO_RESERVED) {
  if (!prevFinalPath || !isInsideDownloadDir(prevFinalPath, root)) return null
  if (fs.existsSync(prevFinalPath) || reserved.has(prevFinalPath)) return null
  return prevFinalPath
}
