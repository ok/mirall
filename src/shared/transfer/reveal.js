// Where a file or folder is on this device, for the client to show in its file manager.
//
// A download and a share resolve to different places on disk: a downloaded file sits at its claim
// path, while a file WE shared is still wherever the user keeps it, which markOwnedSource recorded
// at share time. Both answers are a local path, and both are the WORKER's: a headless daemon has no
// display to open a file manager on, so the opening happens wherever the request came from, against
// the path answered here and tagged as the daemon's.

import path from 'bare-path'
import fs from 'bare-fs'
import { getDownloadDir } from '../core/paths.js'
import { getDownloadedPath, getOwnedSourcePath } from './files.js'
import { createLogger } from '../core/logger.js'
import { CODES } from '../contract/errors.js'
import { daemonPaths } from '../contract/paths.js'
import { AppError } from '../core/errors.js'

const log = createLogger('reveal')

// Where "Open in folder" should point: a downloaded file lives at its landed
// path; a file you own lives at its original source. Only when we know neither
// do we guess <Downloads>/<name> — a last resort, since for an owned file that
// guess points at a Downloads folder the file was never in (which is why
// markOwnedSource records the real source at share time).
/** @internal */
export async function resolveRevealTarget(spaceId, filePath) {
  return (await getDownloadedPath(spaceId, filePath))
    || (await getOwnedSourcePath(spaceId, filePath))
    || path.join(getDownloadDir(spaceId), path.basename(filePath))
}

export async function revealFile(spaceId, filePath) {
  return revealTarget(await resolveRevealTarget(spaceId, filePath))
}

// missingCode is the caller's, because the same walk backs revealing a file and revealing a folder
// and "This file isn't on this device yet." is the wrong sentence for a folder. requireSelf is the
// folder case: a missing file is shown by its folder, but a missing folder has no stand-in the
// client may open — its parent lies outside every root the client is allowed.
/** @param {string} target @param {{ missingCode?: string, requireSelf?: boolean }} [opts] */
export function revealTarget(target, { missingCode = CODES.FILE_NOT_ON_DEVICE, requireSelf = false } = {}) {
  const exists = fs.existsSync(target)
  log.info('reveal target:', target, '(exists:', exists + ')')
  if (!exists && (requireSelf || !isDirectory(path.dirname(target)))) {
    throw new AppError(missingCode, 'Reveal target is not on this device')
  }
  return daemonPaths({ path: target, exists })
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}
