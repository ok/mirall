// The worker's import path for the mount fault vocabulary: the status half comes from the
// contract package (the renderer reads it too), and this adds the errno half, which needs
// core/errors.js and so cannot live there.
import { classifyLocalIoFault } from '../core/errors.js'
import { statusForFaultCode } from '../contract/mount-fault.js'

export {
  STATUS_MOUNT_GONE, AUTO_PAUSE_STATUSES,
  statusForFaultCode, isAutoPauseStatus, isMountFault, mountFault,
} from '../contract/mount-fault.js'

// null means "not a fault this classifies" — the caller falls through to its own handling rather
// than pausing a mount on something transient. Whether a root actually vanished stays the
// caller's question, because only it knows which path to stat.
export function faultFromError(err) {
  const code = classifyLocalIoFault(err)
  return code ? { status: statusForFaultCode(code), code } : null
}
