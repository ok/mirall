// Maps worker transfer and mount-validation error codes to keys in the errors i18n namespace.
const ERROR_I18N_KEY_BY_CODE: Record<string, string> = {
  SOURCE_NOT_ON_DISK: 'sourceNotOnDisk',
  TRANSFER_DISK_FULL: 'transferDiskFull',
  TRANSFER_PERMISSION: 'transferPermission',
  TRANSFER_CHECKSUM: 'transferChecksum',
  TRANSFER_REMOVED: 'transferRemoved',
  TRANSFER_NETWORK: 'transferNetwork',
  TRANSFER_RENAME_FAILED: 'transferRenameFailed',
  LOOSE_FILE_LIMIT: 'looseFileLimit',
}

export function errorCodeToI18nKey(code: string | null | undefined): string {
  if (!code) return 'transferFailed'
  return ERROR_I18N_KEY_BY_CODE[code] ?? 'transferFailed'
}

// Mount-validation rejections carry the offending path as their message (e.g.
// MOUNT_OVERLAPS' message is the overlapping mount path), which is meaningless
// to the user. Map the code to a plain-language reason; null means "no mapping,
// fall back to the raw message".
const MOUNT_ERROR_I18N_KEY_BY_CODE: Record<string, string> = {
  NOT_FOUND: 'mountNoPath',
  MOUNT_OVERLAPS: 'mountOverlaps',
  MOUNT_FORBIDDEN_SYSTEM: 'mountForbiddenSystem',
  MOUNT_FORBIDDEN_APP_DATA: 'mountForbiddenAppData',
  MOUNT_FORBIDDEN_WIN_RESERVED: 'mountForbiddenWinReserved',
  MOUNT_FORBIDDEN_CLOUD_SYNC: 'mountForbiddenCloudSync',
  MOUNT_FORBIDDEN_PERSONAL_ROOT: 'mountForbiddenPersonalRoot',
  MOUNT_INSIDE_DOWNLOADS: 'mountInsideDownloads',
  MOUNT_INSIDE_SELF: 'mountInsideSelf',
  MOUNT_NOT_WRITABLE: 'mountNotWritable',
}

export function mountErrorI18nKey(code: string | null | undefined): string | null {
  if (!code) return null
  return MOUNT_ERROR_I18N_KEY_BY_CODE[code] ?? null
}
