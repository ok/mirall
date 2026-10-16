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

// How a download lands under the space's download folder. FLAT keeps the base name (a click, every
// loose file); TREE keeps the folder: <folder name>/<relPath>. PERSISTED on the pending row, so a
// resume lands where the download began.
export const LAYOUT = Object.freeze({ FLAT: 'flat', TREE: 'tree' })

// `folderName` is carried on the job so the audit row can name the folder without a join — a row
// outlives the share it describes. Null for a loose file (its descriptor has no name) and for a row
// whose record is unreadable. `prevBytes` resumes a partial only while the destination is the one the
// row recorded; a row re-anchored to a re-pointed download folder starts from zero. `destRoot` is
// the download folder the destination was resolved under, which a TREE job's preflight probes
// instead of the folder it creates below it.
export function downloadJob({ spaceId, share, relPath, pendingKey, keyHex, encrypted, epoch = 0, entry, finalPath, destRoot = null, layout = LAYOUT.FLAT, prevFinalPath, prevBytes }) {
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
