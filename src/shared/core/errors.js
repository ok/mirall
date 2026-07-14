// Canonical error codes shared across the worker and (via IPC `code` fields) the
// renderer, which maps them to localized messages. AppError carries a code on a
// throwable; classifyTransferError folds low-level fs/network failures into the
// transfer codes the UI can act on (retry vs. surface).
export const ErrorCodes = {
  UNKNOWN: 'UNKNOWN',
  NOT_FOUND: 'NOT_FOUND',
  SOURCE_NOT_ON_DISK: 'SOURCE_NOT_ON_DISK',
  DRIVE_NOT_FOUND: 'DRIVE_NOT_FOUND',
  PEER_NOT_AVAILABLE: 'PEER_NOT_AVAILABLE',
  UPLOAD_FAILED: 'UPLOAD_FAILED',
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
  TRANSFER_NOT_FOUND: 'TRANSFER_NOT_FOUND',
  SPACE_EXISTS: 'SPACE_EXISTS',
  INVALID_INVITE: 'INVALID_INVITE',
  TIMEOUT: 'TIMEOUT',
  TRANSFER_IN_PROGRESS: 'TRANSFER_IN_PROGRESS',
  TRANSFER_NETWORK: 'TRANSFER_NETWORK',
  TRANSFER_DISK_FULL: 'TRANSFER_DISK_FULL',
  TRANSFER_PERMISSION: 'TRANSFER_PERMISSION',
  TRANSFER_CHECKSUM: 'TRANSFER_CHECKSUM',
  TRANSFER_REMOVED: 'TRANSFER_REMOVED',
  TRANSFER_RENAME_FAILED: 'TRANSFER_RENAME_FAILED',
  EOWNERSHIP: 'EOWNERSHIP',
  SHARE_NAME_COLLISION: 'SHARE_NAME_COLLISION',
  SHARE_NAME_INVALID: 'SHARE_NAME_INVALID',
  OVERLAY_REQUIRED: 'OVERLAY_REQUIRED',
  MOUNT_FORBIDDEN_SYSTEM: 'MOUNT_FORBIDDEN_SYSTEM',
  MOUNT_FORBIDDEN_APP_DATA: 'MOUNT_FORBIDDEN_APP_DATA',
  MOUNT_FORBIDDEN_WIN_RESERVED: 'MOUNT_FORBIDDEN_WIN_RESERVED',
  MOUNT_OVERLAPS: 'MOUNT_OVERLAPS',
  MOUNT_FORBIDDEN_CLOUD_SYNC: 'MOUNT_FORBIDDEN_CLOUD_SYNC',
  MOUNT_INSIDE_DOWNLOADS: 'MOUNT_INSIDE_DOWNLOADS',
  MOUNT_NOT_WRITABLE: 'MOUNT_NOT_WRITABLE',
  MOUNT_INSIDE_SELF: 'MOUNT_INSIDE_SELF',
  MOUNT_FORBIDDEN_PERSONAL_ROOT: 'MOUNT_FORBIDDEN_PERSONAL_ROOT',
  SOURCE_CHANGED: 'SOURCE_CHANGED',
  PREPARE_FAILED: 'PREPARE_FAILED',
  EPATH: 'EPATH',
  DOWNLOAD_FOLDER_INVALID: 'DOWNLOAD_FOLDER_INVALID',
  LOOSE_FILE_LIMIT: 'LOOSE_FILE_LIMIT',
  SHARE_FILE_LIMIT: 'SHARE_FILE_LIMIT',
  CREATOR_DIVERGENCE_UNRESOLVED: 'CREATOR_DIVERGENCE_UNRESOLVED',
}

export class AppError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
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

export function isRetryableTransferError(errorCode) {
  return errorCode === ErrorCodes.TRANSFER_NETWORK
}
