export function isFolderDrop(items: DataTransferItemList): boolean
export function looksLikeFolderDrag(items: DataTransferItemList): boolean
export function firstDirectoryName(items: DataTransferItemList): string | null
export function inspectDragItems(items: DataTransferItemList): {
  kind: 'files' | 'folder'
  count: number
  folderName: string | null
}
