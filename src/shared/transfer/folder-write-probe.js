// Whether a folder takes a new file, asked by creating and removing one. A permission errno alone
// does not say the folder refuses writes: a file another program holds for a moment (an antivirus
// scan during the final rename) raises the same one. Both download producers ask here before they
// believe it. The probe carries the partial suffix, so the boot sweep reclaims one a crash left
// behind.
import fs from 'bare-fs'
import path from 'bare-path'
import { PARTIAL_SUFFIX } from './partial-suffix.js'

const probePath = (dir) => path.join(dir, '.mirall-write-probe' + PARTIAL_SUFFIX)

// Only a refusal counts: any other failure is not evidence the folder is read-only.
/** @param {string} dir @returns {boolean} */
export function folderWritable(dir) {
  const probe = probePath(dir)
  try {
    fs.closeSync(fs.openSync(probe, 'wx'))
    fs.unlinkSync(probe)
    return true
  } catch (err) {
    return !['EACCES', 'EPERM', 'EROFS'].includes(err?.code)
  }
}

// Believed only when a file actually is created: a folder that is gone or unreadable has not been
// fixed.
/** @param {string} dir @returns {boolean} */
export function folderAcceptsWrite(dir) {
  const probe = probePath(dir)
  try {
    fs.closeSync(fs.openSync(probe, 'w'))
    fs.unlinkSync(probe)
    return true
  } catch {
    return false
  }
}
