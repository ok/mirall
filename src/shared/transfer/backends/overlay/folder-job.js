// One download job for the folder engine, whichever path asks for it. Pure, so test/unit drives it.
import { entryRef } from '../../../contract/entry-ref.js'
import { catalogKeyField } from '../../../shares/catalog-keys.js'
import { transferIdFor } from '../../transfer-id.js'

// The label share:rename writes, carried on the job so the engine's audit row can name the folder
// without a join — a row outlives the share it describes. Null when the owner's descriptor is
// unreadable (offline), which is still worth recording.
export const folderLabel = (share) => share?.displayName || share?.name || null

// `prevBytes` resumes a partial only while the destination is the one the row recorded; a row
// re-anchored to a re-pointed download folder starts from zero (its bytes live in the old
// folder's partial, which the boot sweep reclaims).
export function folderJob({ spaceId, share, shareId, ownerKey, relPath, pendingKey, keyHex, encrypted, entry, finalPath, prevFinalPath, prevBytes }) {
  return {
    spaceId, pendingKey, path: pendingKey, relPath, shareId, ...catalogKeyField(keyHex, encrypted),
    folderName: folderLabel(share),
    transferId: transferIdFor(spaceId, shareId, relPath),
    contentHash: entry.contentHash, size: entry.size || 0, sourceSeq: entry.seq,
    ownerKey, verifyKey: entryRef(shareId, relPath),
    finalPath, prevBytes: finalPath === prevFinalPath ? prevBytes || 0 : 0,
  }
}
