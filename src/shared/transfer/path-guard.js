import path from 'bare-path'
import { relKeyEscapes } from '../folders/path-keys.js'
import { AppError, ErrorCodes } from '../core/errors.js'

// The single guarded mount-relative join shared by every content backend AND by the mirror
// materialize path, so a peer-supplied relPath can never read/hash/write a file outside the
// mount. Two guards on purpose: the pure segment check catches an encoded or separator-swapped
// escape, and the path.relative belt catches anything that survives it, whatever the platform
// separator or encoding.
export function pathFromMount(mountPath, relPath) {
  if (relKeyEscapes(relPath)) {
    throw new AppError(ErrorCodes.EPATH, `file path rejected — unsafe segment escapes the share folder: ${relPath}`)
  }
  const abs = path.join(mountPath, ...relPath.split('/'))
  const rel = path.relative(mountPath, abs)
  if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new AppError(ErrorCodes.EPATH, `file path rejected — resolves outside the share folder: ${relPath}`)
  }
  return abs
}
