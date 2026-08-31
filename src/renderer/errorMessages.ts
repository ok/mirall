// Maps worker transfer and mount-validation error codes to keys in the errors i18n namespace.
const ERROR_I18N_KEY_BY_CODE: Record<string, string> = {
  SOURCE_NOT_ON_DISK: 'sourceNotOnDisk',
  TRANSFER_DISK_FULL: 'transferDiskFull',
  TRANSFER_PERMISSION: 'transferPermission',
  TRANSFER_CHECKSUM: 'transferChecksum',
  TRANSFER_REMOVED: 'transferRemoved',
  TRANSFER_NETWORK: 'transferNetwork',
  TRANSFER_RENAME_FAILED: 'transferRenameFailed',
  TRANSFER_DEST_UNAVAILABLE: 'transferDestUnavailable',
  // The worker's catch-all for a fetch it could not classify. Mapped EXPLICITLY even though it
  // resolves to the same string as the fallback: leaving it out is what let every unclassified
  // local-filesystem failure — a deleted, ejected, or file-shadowed download folder among them —
  // reach the user as a bare "Transfer failed", and it would silently swallow the next new code too.
  DOWNLOAD_FAILED: 'transferFailed',
  LOOSE_FILE_LIMIT: 'looseFileLimit',
  SHARE_FILE_LIMIT: 'shareFileLimit',
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
  MOUNT_CONTAINS_DOWNLOADS: 'mountContainsDownloads',
  MOUNT_INSIDE_SELF: 'mountInsideSelf',
  MOUNT_NOT_WRITABLE: 'mountNotWritable',
  DOWNLOAD_FOLDER_OVERLAPS_MOUNT: 'downloadFolderOverlapsMount',
  // Thrown by the folder validator itself (missing, unwritable, not a directory), and thrown
  // FIRST — so leaving it unmapped shows an untranslated English literal to every user.
  DOWNLOAD_FOLDER_INVALID: 'downloadFolderInvalid',
  // share:create refuses a pre-encryption space, and the add-folder modal reads this map.
  SPACE_UNSUPPORTED: 'spaceUnsupported',
}

export function mountErrorI18nKey(code: string | null | undefined): string | null {
  if (!code) return null
  return MOUNT_ERROR_I18N_KEY_BY_CODE[code] ?? null
}
