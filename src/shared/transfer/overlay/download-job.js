// The share a download runs against and the job the engine runs for it. A loose file is the
// LOOSE_SHARE_ID share of its owner, described from the member record at call time and never stored.
// Pure, so test/unit drives it.
import { entryRef } from '../../contract/entry-ref.js'
import { catalogKeyField, readCatalogKey } from '../../shares/catalog-keys.js'
import { shareLabel } from '../../shares/share-label.js'
import { LOOSE_SHARE_ID, looseDrivePath, transferIdFor } from '../transfer-id.js'

/**
 * @typedef {{ id: string, name: string, owner: string | null, displayName?: string,
 *   catalogKey?: string | null, catalogKeyEnc?: string, catalogEpoch?: number }} DownloadShare
 */

// Keyless when the member is unknown or has published no loose catalog: a download then answers
// queued without touching a catalog.
/** @param {object | null | undefined} member @returns {DownloadShare} */
export function looseShareFor(member) {
  const { keyHex, encrypted, epoch } = readCatalogKey(member)
  return { id: LOOSE_SHARE_ID, name: '', owner: member?.publicKey ?? null, ...catalogKeyField(keyHex, encrypted, 'catalogKey', epoch) }
}

// A folder row whose owner record is unreadable resolves through the catalog key the row carries.
/** @returns {DownloadShare} */
export function rowShareFor(row) {
  const { keyHex, encrypted, epoch } = readCatalogKey(row)
  return { id: row.shareId, name: '', owner: row.ownerKey, ...catalogKeyField(keyHex, encrypted, 'catalogKey', epoch) }
}

// PERSISTED: the pending-row key and the download-claim key. A folder file sits under the share's
// immutable on-disk name, a loose file at the root.
export const pendingKeyFor = (share, relPath) =>
  share.id === LOOSE_SHARE_ID ? looseDrivePath(relPath) : '/' + share.name + '/' + relPath

// How a download lands under its download folder. FLAT keeps the base name (every loose file);
// TREE keeps the folder: <folder name>/<relPath>. PERSISTED on the pending row, so a resume lands
// where the download began.
export const LAYOUT = Object.freeze({ FLAT: 'flat', TREE: 'tree' })

// A file from a folder keeps its place in that folder; a loose file has none.
/** @param {{ id: string }} share */
export const layoutFor = (share) => (share.id === LOOSE_SHARE_ID ? LAYOUT.FLAT : LAYOUT.TREE)

// The folder a row lands under. A row written before rows named it resumes where the space's folder
// is now, which is where it was headed when it was written.
/** @param {{ destDir?: string }} row @param {string} spaceFolder @returns {string} */
function rowDestDir(row, spaceFolder) {
  return typeof row.destDir === 'string' && row.destDir ? row.destDir : spaceFolder
}

// Whether a row keeps its own folder against the one a request lands it in. A file under way always
// does: its bytes are there. One that has not started keeps it only while it waits on its owner: a
// request that names a folder moves it there, and one that failed follows the space, so Retry acts
// in the current folder.
/** @param {{ bytesTransferred?: number, errorCode?: string }} row @param {boolean} folderAsked @returns {boolean} */
export function keepsOwnFolder(row, folderAsked) {
  return Number(row.bytesTransferred) > 0 || (!folderAsked && !row.errorCode)
}

// The folder a row lands under: its own while it keeps it (keepsOwnFolder) and can be reached, else
// the folder asked for, else the space's. A row whose folder cannot be reached thereby follows the
// space, so choosing another folder unblocks it. A row whose own folder is that fallback is not
// probed.
/**
 * @param {object} where
 * @param {{ destDir?: string, bytesTransferred?: number, errorCode?: string } | null} [where.row]
 * @param {string | null} [where.asked]
 * @param {string} where.spaceFolder
 * @param {(dir: string) => boolean} where.dirExists
 * @returns {string}
 */
export function landingRoot({ row, asked, spaceFolder, dirExists }) {
  const fallback = asked || spaceFolder
  if (!row || !keepsOwnFolder(row, !!asked)) return fallback
  const own = rowDestDir(row, spaceFolder)
  return own !== fallback && dirExists(own) ? own : fallback
}

// `folderName` is carried on the job so the audit row can name the folder without a join — a row
// outlives the share it describes. Null for a loose file (its descriptor has no name) and for a row
// whose record is unreadable. `prevBytes` resumes a partial only while the destination is the one the
// row recorded; a row that moved to another folder starts from zero. `destRoot` is the download
// folder the destination was resolved under: the row and the claim record it, and a TREE job's
// preflight probes it instead of the folder it creates below it.
export function downloadJob({ spaceId, share, relPath, pendingKey, keyHex, encrypted, epoch = 0, entry, finalPath, destRoot, layout = LAYOUT.FLAT, prevFinalPath, prevBytes }) {
  return {
    spaceId, pendingKey, path: pendingKey, relPath, shareId: share.id,
    ...catalogKeyField(keyHex, encrypted, 'catalogKey', epoch),
    folderName: shareLabel(share),
    transferId: transferIdFor(spaceId, share.id, relPath),
    contentHash: entry.contentHash, size: entry.size || 0, sourceSeq: entry.seq,
    ownerKey: share.owner, verifyKey: entryRef(share.id, relPath),
    finalPath, destRoot, layout, prevBytes: finalPath === prevFinalPath ? prevBytes || 0 : 0,
  }
}

// An active slot an append on `share`'s catalog can invalidate. The engine holds every share's
// slots, and one owner's catalog carries all of that owner's shares in the space.
export const slotOwnedBy = (share) => (slot) => slot.ownerKey === share.owner && slot.job?.shareId === share.id
