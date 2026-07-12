import fs from 'bare-fs'
import path from 'bare-path'
import { nextFreeName } from '../folders/path-keys.js'
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
