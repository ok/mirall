// The renderer round-trips this id (FileCard → files:pause-download), so its shape is a wire
// contract: spaceId|shareId|relPath, with LOOSE_SHARE_ID for space-root loose files.
export const LOOSE_SHARE_ID = '__loose__'
export const transferIdFor = (spaceId, shareId, relPath) => spaceId + '|' + shareId + '|' + relPath
export const looseTransferIdFor = (spaceId, relPath) => transferIdFor(spaceId, LOOSE_SHARE_ID, relPath)
// Which engine owns an id, decided from the id alone — a caller must not have to ask whether a
// transfer is still live (it may have settled) to route a pause/resume to the right backend.
export const isLooseTransferId = (transferId) =>
  typeof transferId === 'string' && transferId.split('|')[1] === LOOSE_SHARE_ID
// The inverse of transferIdFor. A relPath may itself contain '|', so everything past the second
// separator is the path.
export function transferIdParts(transferId) {
  if (typeof transferId !== 'string') return null
  const a = transferId.indexOf('|')
  const b = a < 0 ? -1 : transferId.indexOf('|', a + 1)
  if (b < 0) return null
  return { spaceId: transferId.slice(0, a), shareId: transferId.slice(a + 1, b), relPath: transferId.slice(b + 1) }
}
