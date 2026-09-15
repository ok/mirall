// One download job for the loose engine, whichever path asks for it, and the key grammar a loose
// entry is addressed by: the pending key is its drive path, `'/' + relPath`. Pure, so test/unit
// drives it.
import { entryRef } from '../../../contract/entry-ref.js'
import { LOOSE_SHARE_ID, looseTransferIdFor } from '../../transfer-id.js'

export const looseRelPath = (drivePath) => drivePath.replace(/^\//, '')
export const looseDrivePath = (relPath) => '/' + relPath

// `prevBytes` resumes a partial only while the destination is the one the row recorded; a row
// re-anchored to a re-pointed download folder starts from zero.
export function looseJob({ spaceId, ownerKey, relPath, pendingKey, entry, finalPath, prevFinalPath, prevBytes }) {
  return {
    spaceId, pendingKey, path: pendingKey, relPath,
    transferId: looseTransferIdFor(spaceId, relPath),
    contentHash: entry.contentHash, size: entry.size || 0, sourceSeq: entry.seq,
    ownerKey, verifyKey: entryRef(LOOSE_SHARE_ID, relPath),
    finalPath, prevBytes: finalPath === prevFinalPath ? prevBytes || 0 : 0,
  }
}
