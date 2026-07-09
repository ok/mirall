import fs from 'bare-fs'
import path from 'bare-path'
import { nextFreeName } from '../folders/path-keys.js'
import { PARTIAL_SUFFIX as OVERLAY_PARTIAL_SUFFIX } from './backends/overlay/vendor/transfer.js'

const PARTIAL_SUFFIX = '.partial'

// Pick a Downloads destination that collides with neither a pre-existing file nor a
// partial (an in-flight `.overlay-partial`, or a `.partial` left by an older release),
// so a fresh download never overwrites the user's file or adopts another transfer's orphan.
export function resolveDest (localDir, fileName) {
  const isTaken = (name) => {
    const candidate = path.join(localDir, name)
    return fs.existsSync(candidate) ||
      fs.existsSync(candidate + PARTIAL_SUFFIX) ||
      fs.existsSync(candidate + OVERLAY_PARTIAL_SUFFIX)
  }
  return path.join(localDir, nextFreeName(fileName, isTaken))
}
