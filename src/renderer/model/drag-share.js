// Classifies an OS drag-and-drop payload as folder vs. files, so the drop zone
// can preview the right affordance (add-folder vs. add-files) while the drag is
// still in flight and confirm it with real entries once the drop lands.
/** @param {DataTransferItemList} items */
export function isFolderDrop(items) {
  for (let i = 0; i < items.length; i++) {
    const entry = items[i]?.webkitGetAsEntry?.()
    if (entry?.isDirectory) return true
  }
  return false
}

// During `dragover` the drag is in protected mode and webkitGetAsEntry() returns
// null; only kind/type are readable. A directory item has an empty MIME type, so a
// lone typeless file-kind item is treated as a folder. Single-item only, so a batch
// of extensionless files isn't misread; the drop handler has real entries to correct it.
/** @internal @param {DataTransferItemList} items */
export function looksLikeFolderDrag(items) {
  let sawEntry = false
  for (let i = 0; i < items.length; i++) {
    const entry = items[i]?.webkitGetAsEntry?.()
    if (entry) {
      sawEntry = true
      if (entry.isDirectory) return true
    }
  }
  if (sawEntry) return false
  return items.length === 1 && items[0]?.kind === 'file' && items[0]?.type === ''
}

/** @param {DataTransferItemList} items @returns {string | null} */
export function firstDirectoryName(items) {
  for (let i = 0; i < items.length; i++) {
    const entry = items[i]?.webkitGetAsEntry?.()
    if (entry?.isDirectory) return entry.name
  }
  return null
}

/** @param {DataTransferItemList} items @returns {{ kind: 'files' | 'folder', count: number, folderName: string | null }} */
export function inspectDragItems(items) {
  if (looksLikeFolderDrag(items)) {
    return { kind: 'folder', count: 0, folderName: firstDirectoryName(items) }
  }
  return { kind: 'files', count: items.length, folderName: null }
}
