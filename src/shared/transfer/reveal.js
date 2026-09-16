// Showing a file in the OS file manager.
//
// A download and a share resolve to different places on disk: a downloaded file sits at its claim
// path, while a file WE shared is still wherever the user keeps it, which markOwnedSource recorded
// at share time. Both answers are a local path, so the two resolutions converge before the reveal.

import path from 'bare-path'
import { spawn } from 'bare-subprocess'
import { getDownloadDir } from '../core/paths.js'
import { revealExitIsFailure } from './reveal-exit.js'
import { getDownloadedPath, getOwnedSourcePath } from './files.js'
import { createLogger } from '../core/logger.js'

import { CODES } from '../contract/errors.js'
import { AppError } from '../core/errors.js'
import fs from 'bare-fs'
import os from 'bare-os'

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
  return revealLocalPath(await resolveRevealTarget(spaceId, filePath))
}

// missingCode is the caller's, because the same walk backs revealing a file and revealing a folder
// and "This file isn't on this device yet." is the wrong sentence for a folder.
export function revealLocalPath(target, missingCode = CODES.FILE_NOT_ON_DEVICE) {
  const platform = os.platform()
  const exists = fs.existsSync(target)
  const folder = path.dirname(target)

  log.info('reveal requested:', target, '(platform:', platform + ', exists:', exists + ')')

  if (!exists && !fs.existsSync(folder)) {
    throw new AppError(missingCode, 'Reveal target is not on this device')
  }

  const opts = { stdio: 'ignore', detached: true }
  let child
  try {
    if (platform === 'darwin') {
      child = exists
        ? spawn('open', ['-R', target], opts)
        : spawn('open', [folder], opts)
    } else if (platform === 'win32') {
      child = exists
        ? spawn('explorer.exe', ['/select,', target], opts)
        : spawn('explorer.exe', [folder], opts)
    } else {
      child = spawn('xdg-open', [folder], opts)
    }
  } catch (err) {
    log.error('reveal spawn threw:', err.message)
    throw new AppError(CODES.UNKNOWN, 'Could not reveal file')
  }

  child.on('error', (err) => log.error('reveal subprocess error:', err.message))
  child.on('exit', (code) => {
    if (revealExitIsFailure(platform, code)) log.warn('reveal exited with code:', code)
  })
  child.unref()
}
