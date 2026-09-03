import { CODES } from '../contract/errors.js'

// Canonical error codes shared across the worker and (via IPC `code` fields) the
// renderer, which maps them to localized messages. AppError carries a code on a
// throwable; classifyTransferError folds low-level fs/network failures into the
// transfer codes the UI can act on (retry vs. surface).
// The canonical codes now live in the contract package, which the renderer and main can also read.
// This re-export keeps the ~30 `ErrorCodes.X` call sites unchanged: the name they import is the same
// object, so nothing had to churn to gain one declaration.
export const ErrorCodes = CODES

export class AppError extends Error {
  // `fields` is structured context the router logs and returns on the response frame, so a caller
  // can branch on the failing ids instead of parsing the English message. Optional: all 58 existing
  // call sites pass two arguments and keep working unchanged.
  constructor(code, message, fields = null) {
    super(message)
    this.code = code
    this.fields = fields
  }
}

export function classifyTransferError(err) {
  const msg = (err?.message || '').toLowerCase()
  const code = err?.code
  if (code === 'ENOSPC') return ErrorCodes.TRANSFER_DISK_FULL
  if (code === 'EACCES' || code === 'EPERM') return ErrorCodes.TRANSFER_PERMISSION
  if (msg.includes('checksum') || msg.includes('invalid signature')) return ErrorCodes.TRANSFER_CHECKSUM
  if (msg.includes('block not available') || msg.includes('entry not found') || msg.includes('file not found')) {
    return ErrorCodes.TRANSFER_REMOVED
  }
  return ErrorCodes.TRANSFER_NETWORK
}

// A local filesystem fault that stops a mount doing its job, folded onto the transfer codes the
// renderer already translates. Both folder roles fail the same way — an owner reading its source,
// a mirror writing its destination — and both used to report the raw errno message. The errno
// alone decides it, so this stays free of any fs import: whether a root actually vanished is the
// caller's question, because only it knows which path to stat.
const LOCAL_IO_FAULT_BY_ERRNO = Object.freeze({
  ENOSPC: ErrorCodes.TRANSFER_DISK_FULL,
  EACCES: ErrorCodes.TRANSFER_PERMISSION,
  EPERM: ErrorCodes.TRANSFER_PERMISSION,
  EROFS: ErrorCodes.TRANSFER_PERMISSION,
})

// null means "not a fault this classifies" — the caller then falls through to its generic handling
// rather than pausing a mount on something transient.
export function classifyLocalIoFault(err) {
  return LOCAL_IO_FAULT_BY_ERRNO[err?.code] ?? null
}

// Local-filesystem failures that a download folder which has been deleted, ejected, replaced by
// a file, or served off a dropped network mount can produce. The errno ALONE never settles it —
// the same codes arise from ordinary transient faults — so a caller must confirm by probing the
// destination folder; this set only says "worth probing". Kept here, next to
// classifyTransferError, so the two can't drift, and free of any fs import — that is what keeps
// this module loadable under plain Node, and so unit-testable rather than integration-only.
const LOCAL_DEST_FAULT_CODES = new Set([
  'ENOENT', 'ENOTDIR', 'ENODEV', 'ENXIO', 'EIO', 'ESTALE', 'EACCES', 'EPERM', 'EROFS',
])

export function isLocalDestFault(code) {
  return LOCAL_DEST_FAULT_CODES.has(code)
}

export function isRetryableTransferError(errorCode) {
  return errorCode === ErrorCodes.TRANSFER_NETWORK
}
