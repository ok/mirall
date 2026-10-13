// One download job for the folder engine, whichever path asks for it. Pure, so test/unit drives it.
import { entryRef } from '../../contract/entry-ref.js'
import { catalogKeyField } from '../../shares/catalog-keys.js'
import { shareLabel } from '../../shares/share-label.js'
import { transferIdFor } from '../transfer-id.js'

// `prevBytes` resumes a partial only while the destination is the one the row recorded; a row
// re-anchored to a re-pointed download folder starts from zero (its bytes live in the old
// folder's partial, which the boot sweep reclaims).
export function folderJob({ spaceId, share, shareId, ownerKey, relPath, pendingKey, keyHex, encrypted, epoch = 0, entry, finalPath, prevFinalPath, prevBytes }) {
  return {
    spaceId, pendingKey, path: pendingKey, relPath, shareId, ...catalogKeyField(keyHex, encrypted, 'catalogKey', epoch),
    folderName: shareLabel(share),
    transferId: transferIdFor(spaceId, shareId, relPath),
    contentHash: entry.contentHash, size: entry.size || 0, sourceSeq: entry.seq,
    ownerKey, verifyKey: entryRef(shareId, relPath),
    finalPath, prevBytes: finalPath === prevFinalPath ? prevBytes || 0 : 0,
  }
}
