// The mapping between a local I/O fault code and the durable mount status that names it. It sits
// in the contract package because it is a bridge between two contract vocabularies — CODES and
// the *_MOUNT_STATUS tuples — and because all three runtimes read it: the mirror's pause path and
// the owner's scan settle write these statuses, and the renderer reads them back.
//
// The errno half (which errno IS a fault) stays in the worker: it needs core/errors.js, and this
// package imports nothing outside itself.
import { CODES } from './errors.js'

const STATUS_ENOSPC = 'paused-enospc'
const STATUS_IO_ERROR = 'paused-error'
export const STATUS_MOUNT_GONE = 'mount-point-gone'

// The automatic (recoverable) pause statuses. A user pause ('paused') is deliberately absent: it
// is a decision, and nothing but an explicit resume may lift it.
export const AUTO_PAUSE_STATUSES = Object.freeze([STATUS_MOUNT_GONE, STATUS_ENOSPC, STATUS_IO_ERROR])

// The inverse the renderer needs: a status that names its own reason when none was recorded.
const CODE_BY_STATUS = Object.freeze({ [STATUS_ENOSPC]: CODES.TRANSFER_DISK_FULL })

// A full disk outranks a permission fault: it stops the whole device rather than one subtree.
export function statusForFaultCode (code) {
  return code === CODES.TRANSFER_DISK_FULL ? STATUS_ENOSPC : STATUS_IO_ERROR
}

export function isAutoPauseStatus (status) {
  return AUTO_PAUSE_STATUSES.includes(status)
}

export function isMountFault (status) {
  return status === STATUS_ENOSPC || status === STATUS_IO_ERROR
}

// What the folder screen names the fault by. `code` is an error code the renderer already
// translates, never a raw errno message, and a status with no reason recorded still names itself.
export function mountFault (status, lastError) {
  if (!isMountFault(status)) return null
  return { status, code: lastError || CODE_BY_STATUS[status] || null }
}
