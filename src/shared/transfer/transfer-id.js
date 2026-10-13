// The renderer round-trips this id (FileRow → files:pause-download), so its shape is a wire
// contract: spaceId|shareId|relPath, with LOOSE_SHARE_ID for space-root loose files.
import { LOOSE_SHARE_ID } from '../contract/entry-ref.js'
export { LOOSE_SHARE_ID }
export const transferIdFor = (spaceId, shareId, relPath) => spaceId + '|' + shareId + '|' + relPath
export const looseTransferIdFor = (spaceId, relPath) => transferIdFor(spaceId, LOOSE_SHARE_ID, relPath)
// PERSISTED: a loose file's drive path keys its pending row and its download claim
// (`<spaceId>:<drivePath>`); a different grammar orphans every row and claim already on disk.
export const looseDrivePath = (relPath) => '/' + relPath
export const looseRelPath = (drivePath) => drivePath.replace(/^\//, '')
// The path the renderer names a file by: a loose file is rooted at '/', a folder file is the bare
// relPath of its share.
export const rendererPath = (shareId, relPath) => (shareId === LOOSE_SHARE_ID ? looseDrivePath(relPath) : relPath)
// The inverse of transferIdFor. A relPath may itself contain '|', so everything past the second
// separator is the path.
export function transferIdParts(transferId) {
  if (typeof transferId !== 'string') return null
  const a = transferId.indexOf('|')
  const b = a < 0 ? -1 : transferId.indexOf('|', a + 1)
  if (b < 0) return null
  return { spaceId: transferId.slice(0, a), shareId: transferId.slice(a + 1, b), relPath: transferId.slice(b + 1) }
}
