// Which ErrorCode a refused or failed download gets. Pure: the destination is read through the
// DestProbe below, which the engine builds per job or per pending row, so every rule unit-tests
// under Node with a hand-made probe. No bare-* imports.
import { CODES } from '../../../contract/errors.js'
import { classifyTransferError, isLocalDestFault } from '../../../core/errors.js'
import { shortfall } from '../../free-space.js'
import { isUserBlockedFault } from './fetch-policy.js'

/**
 * The destination a rule is judged against. The engine builds one per job or per pending row; each
 * reading is a syscall the caller may answer from a kept verdict.
 * @typedef {object} DestProbe
 * @property {() => boolean} dirExists
 * @property {() => boolean} dirWritable
 * @property {() => boolean} dirAcceptsWrite
 * @property {() => number} freeBytes
 * @property {() => number} allocatedBytes
 */

/**
 * A pending row's terminal verdict as the clear rule judges it: the code, the byte count the next
 * attempt must fit (null when the row carries none), and whether the preflight is the check that
 * refused it.
 * @typedef {object} RowFault
 * @property {string} [code]
 * @property {number | null} [size]
 * @property {boolean} [refusedByPreflight]
 */

// Refuse before any scheduler/holder work. The folder is checked first and on its own: the
// receive path mkdir -p's the destination, so a folder the user deleted would be silently
// recreated and the download would complete into it with no error to classify; and freeBytes
// fails open on a statfs error, so a gone root would sail past the space check. The size is
// known up front, so a volume that cannot hold it is refused now rather than when it fills.
// A resumed partial's allocated bytes count against the requirement.
/**
 * @param {number} size
 * @param {DestProbe} dest
 * @returns {string | null}
 */
export function preflightFault(size, dest) {
  if (!dest.dirExists()) return CODES.TRANSFER_DEST_UNAVAILABLE
  const missing = shortfall({ freeBytes: dest.freeBytes(), needBytes: size, allocatedBytes: dest.allocatedBytes() })
  return missing > 0 ? CODES.TRANSFER_DISK_FULL : null
}

// A terminal fetch failure's ErrorCode. Disk-full/permission/removed classify specifically;
// anything unrecognized stays the generic DOWNLOAD_FAILED rather than masquerading as a network
// error. The folder is probed before a local-destination fault is believed: the same ENOENT /
// ENOTDIR / EACCES arise from a transient fault and from a folder the user deleted, ejected or
// replaced with a file — on macOS /Volumes is root-owned, so a fetch into an ejected volume fails
// EACCES and would otherwise send the user to check permissions that are fine.
//
// A permission errno is believed only when the folder itself refuses a write: the same errno comes
// from a file another program holds for a moment (an antivirus scan during the final rename), which
// a later attempt clears, so that stays the generic, retryable failure.
/**
 * @param {{ code?: string, cause?: { code?: string } }} result
 * @param {DestProbe} dest
 * @returns {string}
 */
export function terminalFault(result, dest) {
  if (result.code === 'EHASHMISMATCH') return CODES.TRANSFER_CHECKSUM
  if (isLocalDestFault(result.cause?.code) && !dest.dirExists()) return CODES.TRANSFER_DEST_UNAVAILABLE
  const classified = classifyTransferError(result.cause)
  if (classified === CODES.TRANSFER_PERMISSION && dest.dirWritable()) return CODES.DOWNLOAD_FAILED
  return classified === CODES.TRANSFER_NETWORK ? CODES.DOWNLOAD_FAILED : classified
}

// A terminal verdict the user has since acted on. A fault clears only on a reading strictly
// stronger than the one that recorded it, so a row that is still blocked never spends an attempt
// to learn it:
//   - a permission fault is recorded when the folder refuses an exclusive create, and clears when
//     it accepts a plain one;
//   - a missing-destination fault is recorded when the folder is not there, and clears on the
//     preflight, which cannot pass without it;
//   - a disk-full fault clears on the preflight only when the preflight is what refused it. The
//     same code from a write that hit ENOSPC outranks every free-space reading — exhausted inodes,
//     and space a volume reports but will not hand over, both produce it on a volume the preflight
//     calls roomy — so that row waits for the user's Retry.
// A row that carries no byte count is never judged against the volume: the start gate asks for the
// job's real size, which nothing on the row can stand in for.
/**
 * @param {RowFault} fault
 * @param {DestProbe} dest
 * @returns {boolean}
 */
export function faultCleared({ code, size = null, refusedByPreflight = false }, dest) {
  if (code === CODES.TRANSFER_PERMISSION) return dest.dirAcceptsWrite()
  if (!isUserBlockedFault(code)) return false
  if (code === CODES.TRANSFER_DISK_FULL && !(refusedByPreflight && size !== null)) return false
  return preflightFault(size ?? 0, dest) === null
}

// Whether a pending row still waits on its owner's bytes: a fault only the user can clear waits on
// the user instead, until it has cleared.
/**
 * @param {RowFault} fault
 * @param {DestProbe} dest
 * @returns {boolean}
 */
export function faultAwaitsOwner(fault, dest) {
  return !isUserBlockedFault(fault.code) || faultCleared(fault, dest)
}
