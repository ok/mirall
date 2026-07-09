// The renderer round-trips this id (FileCard → files:pause-download), so its shape is a wire
// contract: spaceId|shareId|relPath, with LOOSE_SHARE_ID for space-root loose files.
export const LOOSE_SHARE_ID = '__loose__'
export const transferIdFor = (spaceId, shareId, relPath) => spaceId + '|' + shareId + '|' + relPath
export const looseTransferIdFor = (spaceId, relPath) => transferIdFor(spaceId, LOOSE_SHARE_ID, relPath)
