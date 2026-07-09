import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'

// The space-storage widget's two-peer contract: both peers agree on the space
// TOTAL (owner's folder + loose file), while on-device tracks what each peer
// actually holds — the owner everything, the consumer nothing until it mirrors
// the folder, then exactly the folder's bytes (the un-downloaded loose file
// keeps counting toward the total only).
test('space storage summary: shared total on both peers; on-device follows the mirror', { timeout: 90000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey

  // A publishes a folder with two files plus one loose file.
  const share = await A.request('share:create', { spaceId, name: 'Photos' })
  const folder = mkTmpDir(t)
  const picBytes = patternedBytes(20 * 1024, 11)
  fs.writeFileSync(path.join(folder, 'pic.bin'), picBytes)
  fs.writeFileSync(path.join(folder, 'readme.txt'), 'hello mirror')
  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  await scanDone

  const looseDir = mkTmpDir(t)
  fs.writeFileSync(path.join(looseDir, 'loose.txt'), 'loose file bytes')
  await A.request('files:add', { spaceId, filePath: path.join(looseDir, 'loose.txt'), fileName: 'loose.txt' })

  const folderBytes = picBytes.length + 'hello mirror'.length
  const totalBytes = folderBytes + 'loose file bytes'.length

  // Owner: the whole space is on its device.
  const aSum = await A.until('space:storage-summary', { spaceId },
    (s) => s.totalBytes === totalBytes && s.onDeviceBytes === totalBytes)
  t.is(aSum.onDeviceBytes, totalBytes, 'owner has everything on device')

  // Consumer, pre-mirror: full total visible, nothing on device.
  await B.until('share:list', { spaceId }, (list) => list.some((s) => s.id === share.id))
  const bPre = await B.until('space:storage-summary', { spaceId },
    (s) => s.totalBytes === totalBytes, { ms: 30000 })
  t.is(bPre.onDeviceBytes, 0, 'nothing on device before mirroring')

  // B mirrors the folder → on-device grows to exactly the folder's bytes.
  const mirrorDir = mkTmpDir(t)
  const active = B.waitFor('event:foreign-folder-mount-status',
    (m) => m.shareId === share.id && m.status === 'active')
  await B.request('foreign-folder:mount', { spaceId, shareId: share.id, ownerKey: aKey, mountPath: mirrorDir })
  await active
  const bPost = await B.until('space:storage-summary', { spaceId },
    (s) => s.onDeviceBytes === folderBytes, { ms: 30000 })
  t.is(bPost.totalBytes, totalBytes, 'total unchanged by mirroring')
  t.is(bPost.onDeviceBytes, folderBytes, 'on-device = the mirrored folder, not the un-downloaded loose file')
})
