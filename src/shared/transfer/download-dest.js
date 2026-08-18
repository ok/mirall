import fs from 'bare-fs'
import path from 'bare-path'
import { nextFreeName } from '../folders/path-keys.js'
import { isInsideDownloadDir } from '../core/paths.js'
import { PARTIAL_SUFFIX } from './partial-suffix.js'

// Pick a Downloads destination that collides with neither a pre-existing file nor an
// in-flight partial, so a fresh download never overwrites the user's file or adopts
// another transfer's orphan.
export function resolveDest (localDir, fileName) {
  const isTaken = (name) => {
    const candidate = path.join(localDir, name)
    return fs.existsSync(candidate) || fs.existsSync(candidate + PARTIAL_SUFFIX)
  }
  return path.join(localDir, nextFreeName(fileName, isTaken))
}

// The destination for a transfer that may already have a pinned one. A pending row records
// `finalPath` at start, and that pin outlives a download-folder change — so a paused transfer
// resumed after the user re-pointed the space would complete into the OLD folder, land outside
// the space's scope, and report as never downloaded (inviting a full re-download alongside it).
// Reuse the pin only while it still sits inside `localDir`; otherwise re-resolve. The bytes
// already in the old folder's partial are given up — the boot sweep reclaims them — which is
// the cost of honouring the folder the user just chose.
export function reuseDest (prevFinalPath, localDir, fileName) {
  if (prevFinalPath && isInsideDownloadDir(prevFinalPath, localDir)) return prevFinalPath
  return resolveDest(localDir, fileName)
}
