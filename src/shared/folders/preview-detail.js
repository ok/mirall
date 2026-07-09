// The per-file preview list is a confirmation aid, not a manifest. Above this many
// action-set files (uploads for owned, downloads for foreign) the dialog shows the
// summary counts only and omits the list. `actionCount` is the number of files that
// would populate the list (toUpload / toDownload), not the total files on disk.
export const PREVIEW_DETAIL_MAX_FILES = 50

export function includePerFile(actionCount) {
  return actionCount <= PREVIEW_DETAIL_MAX_FILES
}
