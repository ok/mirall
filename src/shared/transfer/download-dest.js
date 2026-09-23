import fs from 'bare-fs'
import path from 'bare-path'
import { nextFreeName } from '../folders/path-keys.js'
import { isInsideDownloadDir } from '../core/paths.js'
import { PARTIAL_SUFFIX } from './partial-suffix.js'

// A name is taken by a final file OR an in-flight partial, so a fresh destination, a collision
// sibling and a conflict copy never land on the user's file or another transfer's orphan.
export function nameTakenAt(absPath) {
  return fs.existsSync(absPath) || fs.existsSync(absPath + PARTIAL_SUFFIX)
}

export function resolveDest(localDir, fileName) {
  return path.join(localDir, nextFreeName(fileName, (name) => nameTakenAt(path.join(localDir, name))))
}

// The destination for a transfer that may already have a pinned one. A pending row records
// `finalPath` at start, and that pin outlives a download-folder change — so a paused transfer
// resumed after the user re-pointed the space would complete into the OLD folder, land outside
// the space's scope, and report as never downloaded (inviting a full re-download alongside it).
// Reuse the pin only while it still sits inside `localDir`; otherwise re-resolve. The bytes
// already in the old folder's partial are given up — the boot sweep reclaims them — which is
// the cost of honouring the folder the user just chose.
export function reuseDest(prevFinalPath, localDir, fileName) {
  if (prevFinalPath && isInsideDownloadDir(prevFinalPath, localDir)) return prevFinalPath
  return resolveDest(localDir, fileName)
}
