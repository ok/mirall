// Every transfer on this device as one list, grouped by space: the downloads the user asked for and
// the files other members are fetching from it. Pure: the worker's handler reads the pending rows,
// the engine and the serve ledger, and this turns them into the rows the listings already use.
//
// A download is listed while it is a transfer: moving, waiting for a slot, paused, or failed. A row
// that is still waiting for its owner to hash the file is not one yet, and a finished download has
// no pending row. A serve is listed once a member is fetching; one that only has members waiting
// while the file is hashed is not.
import { consumerRowStatusFor } from './transfer-status.js'
import { FILE_STATUS } from '../contract/statuses.js'
import { LOOSE_SHARE_ID, transferIdFor } from './transfer-id.js'
/** @import { TransferDownload, TransferServing, TransferSpace } from '../contract/responses.js' */

const LISTED = new Set([
  FILE_STATUS.DOWNLOADING, FILE_STATUS.WAITING, FILE_STATUS.PAUSED_INTERRUPTED, FILE_STATUS.PAUSED_OFFLINE, FILE_STATUS.ERROR,
])

// A folder row's key is '/<folder>/<relPath>', so the folder's name is what sits between.
function folderNameOf(row) {
  const tail = '/' + row.relPath
  return row.filePath.endsWith(tail) ? row.filePath.slice(1, -tail.length) : ''
}

/**
 * The listing row of one pending download, or null when it is not a transfer.
 * @param {string} spaceId
 * @param {{ filePath: string, relPath: string, shareId: string, ownerKey: string, total?: number, contentHash?: string, bytesTransferred?: number, errorCode?: string }} row
 * @param {{ phase: 'waiting' | 'active' | null, ownerOnline: boolean, ownerName: string }} facts
 * @returns {TransferDownload | null}
 */
export function downloadRowFor(spaceId, row, { phase, ownerOnline, ownerName }) {
  const view = consumerRowStatusFor({
    hashed: Boolean(row.contentHash), isActive: phase !== null, isWaiting: phase === 'waiting', pendingRow: row, ownerOnline,
  })
  if (!LISTED.has(view.status)) return null
  const content = {
    size: row.total || 0, hash: row.contentHash || '', mtime: 0, status: view.status, localPath: null,
    pendingBytes: view.pendingBytes, errorCode: view.errorCode, transferId: transferIdFor(spaceId, row.shareId, row.relPath),
  }
  if (row.shareId === LOOSE_SHARE_ID) {
    const file = { path: row.filePath, ...content, owner: { displayName: ownerName, publicKey: row.ownerKey } }
    return { kind: 'loose', shareId: row.shareId, ownerKey: row.ownerKey, folder: null, file }
  }
  return { kind: 'share', shareId: row.shareId, ownerKey: row.ownerKey, folder: folderNameOf(row), file: { relPath: row.relPath, ...content } }
}

/**
 * @param {{ downloads: Array<{ spaceId: string, download: TransferDownload }>, serving: TransferServing[] }} input
 * @returns {TransferSpace[]}
 */
export function groupTransfers({ downloads, serving }) {
  /** @type {Map<string, TransferSpace>} */
  const bySpace = new Map()
  const group = (spaceId) => {
    let g = bySpace.get(spaceId)
    if (!g) bySpace.set(spaceId, (g = { spaceId, downloads: [], serving: [] }))
    return g
  }
  for (const { spaceId, download } of downloads) group(spaceId).downloads.push(download)
  for (const s of serving) if (s.peers.length > 0) group(s.spaceId).serving.push(s)
  return [...bySpace.values()]
}
