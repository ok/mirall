import { CODES } from '../contract/errors.js'

// AppError — the throwable that carries a contract error code (`code`) plus optional structured
// `fields` — and the classifiers that fold low-level fs/network failures onto the transfer codes
// the renderer can act on (retry vs. surface). The codes themselves are declared once in
// contract/errors.js, which this module imports directly.

export class AppError extends Error {
  // `fields` is structured context the router logs and returns on the response frame, so a caller
  // can branch on the failing ids instead of parsing the English message. Optional — the
  // two-argument call is the common form (72 sites today).
  constructor(code, message, fields = null) {
    super(message)
    this.code = code
    this.fields = fields
  }
}

export function classifyTransferError(err) {
  const msg = (err?.message || '').toLowerCase()
  const code = err?.code
  if (code === 'ENOSPC') return CODES.TRANSFER_DISK_FULL
  if (code === 'EACCES' || code === 'EPERM') return CODES.TRANSFER_PERMISSION
  if (msg.includes('checksum') || msg.includes('invalid signature')) return CODES.TRANSFER_CHECKSUM
  if (msg.includes('block not available') || msg.includes('entry not found') || msg.includes('file not found')) {
    return CODES.TRANSFER_REMOVED
  }
  return CODES.TRANSFER_NETWORK
}

// A local filesystem fault that stops a mount doing its job, folded onto the transfer codes the
// renderer already translates. Both folder roles fail the same way — an owner reading its source,
// a mirror writing its destination. The errno alone decides it, so this stays free of any fs
// import: whether a root actually vanished is the caller's question, because only it knows which
// path to stat.
const LOCAL_IO_FAULT_BY_ERRNO = Object.freeze({
  ENOSPC: CODES.TRANSFER_DISK_FULL,
  EACCES: CODES.TRANSFER_PERMISSION,
  EPERM: CODES.TRANSFER_PERMISSION,
  EROFS: CODES.TRANSFER_PERMISSION,
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

// test seam
export function isRetryableTransferError(errorCode) {
  return errorCode === CODES.TRANSFER_NETWORK
}
