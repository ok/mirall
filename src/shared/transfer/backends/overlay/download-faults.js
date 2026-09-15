// Which ErrorCode a refused or failed download gets. Pure: the destination is read through a
// probe the engine builds per job ({ dirExists(), freeBytes(), allocatedBytes() }), so both rules
// unit-test under Node with a hand-made probe. No bare-* imports.
import { CODES } from '../../../contract/errors.js'
import { classifyTransferError, isLocalDestFault } from '../../../core/errors.js'
import { shortfall } from '../../free-space.js'

// Refuse before any scheduler/holder work. The folder is checked first and on its own: the
// receive path mkdir -p's the destination, so a folder the user deleted would be silently
// recreated and the download would complete into it with no error to classify; and freeBytes
// fails open on a statfs error, so a gone root would sail past the space check. The size is
// known up front, so a volume that cannot hold it is refused now rather than when it fills.
// A resumed partial's allocated bytes count against the requirement.
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
export function terminalFault(result, dest) {
  if (result.code === 'EHASHMISMATCH') return CODES.TRANSFER_CHECKSUM
  if (isLocalDestFault(result.cause?.code) && !dest.dirExists()) return CODES.TRANSFER_DEST_UNAVAILABLE
  const classified = classifyTransferError(result.cause)
  return classified === CODES.TRANSFER_NETWORK ? CODES.DOWNLOAD_FAILED : classified
}
