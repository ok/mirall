// The mapping between a local I/O fault code and the durable mount status that names it. It sits
// in the contract package because it is a bridge between two contract vocabularies — CODES and
// the *_MOUNT_STATUS tuples — and because all three runtimes read it: the mirror's pause path and
// the owner's scan settle write these statuses, and the renderer reads them back.
//
// The errno half (which errno IS a fault) stays in the worker: it needs core/errors.js, and this
// package imports nothing outside itself.
import { MOUNT_STATUS } from './statuses.js'
import { CODES } from './errors.js'

const STATUS_ENOSPC = MOUNT_STATUS.PAUSED_ENOSPC
const STATUS_IO_ERROR = MOUNT_STATUS.PAUSED_ERROR
export const STATUS_MOUNT_GONE = MOUNT_STATUS.MOUNT_POINT_GONE

// The automatic (recoverable) pause statuses. A user pause ('paused') is deliberately absent: it
// is a decision, and nothing but an explicit resume may lift it.
export const AUTO_PAUSE_STATUSES = Object.freeze([STATUS_MOUNT_GONE, STATUS_ENOSPC, STATUS_IO_ERROR])

/** @typedef {typeof STATUS_ENOSPC | typeof STATUS_IO_ERROR} MountFaultStatus */
/** @typedef {{ status: MountFaultStatus, code: string | null }} MountFault */

// The inverse the renderer needs: a status that names its own reason when none was recorded.
/** @type {Readonly<Partial<Record<MountFaultStatus, string>>>} */
const CODE_BY_STATUS = Object.freeze({ [STATUS_ENOSPC]: CODES.TRANSFER_DISK_FULL })

// A full disk outranks a permission fault: it stops the whole device rather than one subtree.
/** @param {string | null | undefined} code @returns {MountFaultStatus} */
export function statusForFaultCode(code) {
  return code === CODES.TRANSFER_DISK_FULL ? STATUS_ENOSPC : STATUS_IO_ERROR
}

/** @param {string | null | undefined} status */
export function isAutoPauseStatus(status) {
  return AUTO_PAUSE_STATUSES.some((s) => s === status)
}

/** @param {string | null | undefined} status @returns {status is MountFaultStatus} */
export function isMountFault(status) {
  return status === STATUS_ENOSPC || status === STATUS_IO_ERROR
}

// What the folder screen names the fault by. `code` is an error code the renderer already
// translates, never a raw errno message, and a status with no reason recorded still names itself.
/** @param {string | null | undefined} status @param {string | null} [lastError] @returns {MountFault | null} */
export function mountFault(status, lastError) {
  if (!isMountFault(status)) return null
  return { status, code: lastError || CODE_BY_STATUS[status] || null }
}
