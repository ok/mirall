// The single code -> i18n key map. It was two maps because NOT_FOUND meant "choose a folder" in the
// picker and "share not found" everywhere else; the codes are split now, so one map is enough and a
// second would only re-open the door to a code meaning two things.
export const ERROR_I18N_KEY_BY_CODE = {
  TRANSFER_DISK_FULL: 'transferDiskFull',
  TRANSFER_PERMISSION: 'transferPermission',
  TRANSFER_CHECKSUM: 'transferChecksum',
  TRANSFER_REMOVED: 'transferRemoved',
  TRANSFER_NETWORK: 'transferNetwork',
  TRANSFER_RENAME_FAILED: 'transferRenameFailed',
  TRANSFER_DEST_UNAVAILABLE: 'transferDestUnavailable',
  // The worker's catch-all for a fetch it could not classify. Mapped EXPLICITLY even though it
  // resolves to the same string as the transfer fallback: leaving it out is what let every
  // unclassified local-filesystem failure reach the user as a bare "Transfer failed".
  DOWNLOAD_FAILED: 'transferFailed',
  SOURCE_NOT_ON_DISK: 'sourceNotOnDisk',
  FILE_SOURCE_MISSING: 'fileSourceMissing',
  FILE_NOT_ON_DEVICE: 'fileNotOnDevice',
  LOOSE_FILE_LIMIT: 'looseFileLimit',
  SHARE_FILE_LIMIT: 'shareFileLimit',
  SHARE_NAME_INVALID: 'shareNameInvalid',
  SHARE_NAME_COLLISION: 'shareNameCollision',
  MOUNT_PATH_MISSING: 'mountNoPath',
  MOUNT_OVERLAPS: 'mountOverlaps',
  MOUNT_FORBIDDEN_SYSTEM: 'mountForbiddenSystem',
  MOUNT_FORBIDDEN_APP_DATA: 'mountForbiddenAppData',
  MOUNT_FORBIDDEN_WIN_RESERVED: 'mountForbiddenWinReserved',
  MOUNT_FORBIDDEN_CLOUD_SYNC: 'mountForbiddenCloudSync',
  MOUNT_FORBIDDEN_PERSONAL_ROOT: 'mountForbiddenPersonalRoot',
  MOUNT_INSIDE_DOWNLOADS: 'mountInsideDownloads',
  MOUNT_CONTAINS_DOWNLOADS: 'mountContainsDownloads',
  MOUNT_INSIDE_SELF: 'mountInsideSelf',
  MOUNT_NOT_WRITABLE: 'mountNotWritable',
  MOUNT_NOT_ON_DEVICE: 'mountNotOnDevice',
  DOWNLOAD_FOLDER_OVERLAPS_MOUNT: 'downloadFolderOverlapsMount',
  DOWNLOAD_FOLDER_INVALID: 'downloadFolderInvalid',
  SOURCE_FOLDER_MISSING: 'sourceFolderMissing',
  SPACE_NOT_FOUND: 'spaceNotFound',
  SHARE_NOT_FOUND: 'shareNotFound',
  SHARE_MODE_UNSUPPORTED: 'shareModeUnsupported',
  SPACE_UNSUPPORTED: 'spaceUnsupported',
}

export function errorI18nKey (code, fallbackKey) {
  if (!code) return fallbackKey
  return ERROR_I18N_KEY_BY_CODE[code] ?? fallbackKey
}

// A file row's stored errorCode. Its fallback stays "Transfer failed": the row is about a transfer,
// so the generic sentence would be less specific, not more.
export function errorCodeToI18nKey (code) {
  return errorI18nKey(code, 'transferFailed')
}

// Mount-validation rejections carry the offending path as their message, which is meaningless to
// the user. null means "no mapping, fall back to the raw message" — the display boundary replaces
// this shape wholesale.
export function mountErrorI18nKey (code) {
  if (!code) return null
  return ERROR_I18N_KEY_BY_CODE[code] ?? null
}

// A mount fault reads the same map with its own fallback: the reason lands mid-sentence in the
// folder screen's fault strip, where "Transfer failed" would describe the wrong thing.
export function mountFaultReasonKey (code) {
  return errorI18nKey(code, 'mountFaultUnknown')
}
