// Every error code that can cross the IPC boundary, and the only place they are declared.
// The ten that were thrown as bare strings are ADOPTED here under the spelling the code already
// emits — renaming one would be a wire-visible change to something the renderer branches on.
export const CODES = Object.freeze({
  CREATOR_DIVERGENCE_UNRESOLVED: 'CREATOR_DIVERGENCE_UNRESOLVED',
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',  // raised by the router when a payload fails its declared shape
  DOWNLOAD_FOLDER_INVALID: 'DOWNLOAD_FOLDER_INVALID',
  DOWNLOAD_FOLDER_OVERLAPS_MOUNT: 'DOWNLOAD_FOLDER_OVERLAPS_MOUNT',
  DRIVE_NOT_FOUND: 'DRIVE_NOT_FOUND',
  ECANCELLED: 'ECANCELLED',  // adopted from a bare string
  EHASHMISMATCH: 'EHASHMISMATCH',  // adopted from a bare string
  EIO: 'EIO',  // adopted from a bare string
  EOWNERSHIP: 'EOWNERSHIP',
  EPATH: 'EPATH',
  INVALID_INVITE: 'INVALID_INVITE',
  INVITE_EXPIRED: 'INVITE_EXPIRED',  // adopted from a bare string
  INVITE_INVALID: 'INVITE_INVALID',  // adopted from a bare string
  LEAVE_IN_PROGRESS: 'LEAVE_IN_PROGRESS',  // adopted from a bare string
  LOOSE_FILE_LIMIT: 'LOOSE_FILE_LIMIT',
  MOUNT_CONTAINS_DOWNLOADS: 'MOUNT_CONTAINS_DOWNLOADS',
  MOUNT_FORBIDDEN_APP_DATA: 'MOUNT_FORBIDDEN_APP_DATA',
  MOUNT_FORBIDDEN_CLOUD_SYNC: 'MOUNT_FORBIDDEN_CLOUD_SYNC',
  MOUNT_FORBIDDEN_PERSONAL_ROOT: 'MOUNT_FORBIDDEN_PERSONAL_ROOT',
  MOUNT_FORBIDDEN_SYSTEM: 'MOUNT_FORBIDDEN_SYSTEM',
  MOUNT_FORBIDDEN_WIN_RESERVED: 'MOUNT_FORBIDDEN_WIN_RESERVED',
  MOUNT_INSIDE_DOWNLOADS: 'MOUNT_INSIDE_DOWNLOADS',
  MOUNT_INSIDE_SELF: 'MOUNT_INSIDE_SELF',
  MOUNT_NOT_WRITABLE: 'MOUNT_NOT_WRITABLE',
  MOUNT_OVERLAPS: 'MOUNT_OVERLAPS',
  NOT_A_MEMBER: 'NOT_A_MEMBER',  // adopted from a bare string
  NOT_FOUND: 'NOT_FOUND',
  OVERLAY_REQUIRED: 'OVERLAY_REQUIRED',
  PEER_NOT_AVAILABLE: 'PEER_NOT_AVAILABLE',
  PREPARE_FAILED: 'PREPARE_FAILED',
  PREVIEW_CANCELLED: 'PREVIEW_CANCELLED',  // adopted from a bare string
  REMOVABLE_OR_NETWORK: 'REMOVABLE_OR_NETWORK',  // adopted from a bare string
  SHARE_FILE_LIMIT: 'SHARE_FILE_LIMIT',
  SHARE_NAME_COLLISION: 'SHARE_NAME_COLLISION',
  SHARE_NAME_INVALID: 'SHARE_NAME_INVALID',
  SOURCE_CHANGED: 'SOURCE_CHANGED',
  SOURCE_NOT_ON_DISK: 'SOURCE_NOT_ON_DISK',
  SPACE_EXISTS: 'SPACE_EXISTS',
  SPACE_UNSUPPORTED: 'SPACE_UNSUPPORTED',  // created before v1.7.0; no SCK, and no path to one
  TCC_GATED: 'TCC_GATED',  // adopted from a bare string
  TIMEOUT: 'TIMEOUT',
  TRANSFER_CHECKSUM: 'TRANSFER_CHECKSUM',
  TRANSFER_DEST_UNAVAILABLE: 'TRANSFER_DEST_UNAVAILABLE',
  TRANSFER_DISK_FULL: 'TRANSFER_DISK_FULL',
  TRANSFER_IN_PROGRESS: 'TRANSFER_IN_PROGRESS',
  TRANSFER_NETWORK: 'TRANSFER_NETWORK',
  TRANSFER_NOT_FOUND: 'TRANSFER_NOT_FOUND',
  TRANSFER_PERMISSION: 'TRANSFER_PERMISSION',
  TRANSFER_REMOVED: 'TRANSFER_REMOVED',
  TRANSFER_RENAME_FAILED: 'TRANSFER_RENAME_FAILED',
  UNKNOWN: 'UNKNOWN',
  UPLOAD_FAILED: 'UPLOAD_FAILED',
})

export const CODE_NAMES = Object.freeze(Object.keys(CODES))

// Ordinary control flow rather than faults: the user cancelled, or a bounded read gave up as
// designed. The IPC router logs these at debug so the warn level keeps its meaning.
export const EXPECTED_CODES = Object.freeze(['ECANCELLED', 'PREVIEW_CANCELLED'])

// Declared but thrown nowhere as of 2026-08-30. Kept rather than deleted: several are the
// vocabulary a planned feature will use, and deleting them would make the parity test pass by
// shrinking the contract instead of fixing the code. The test asserts this list only shrinks.
export const UNUSED_CODES = Object.freeze([
  'INVALID_INVITE',
  'MOUNT_INSIDE_SELF',
  'PEER_NOT_AVAILABLE',
  'PREPARE_FAILED',
  'SOURCE_CHANGED',
  'SPACE_EXISTS',
  'TIMEOUT',
  'TRANSFER_IN_PROGRESS',
  'TRANSFER_NOT_FOUND',
  'TRANSFER_RENAME_FAILED',
  'UPLOAD_FAILED',
])

// Named export for the router's own use. Declared inside CODES as well, so the "is every
// user-visible code mapped?" ratchet can see it — it was invisible to that test while it lived
// outside, which is how a code the user CAN see escaped the count.
export const INVALID_ARGUMENT = CODES.INVALID_ARGUMENT
