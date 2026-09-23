import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// Overlay serves straight from the source file, so sharing a folder grows neither the owner's nor a
// browsing peer's app storage by the file bytes. Only a real run crosses the worker IPC on both.
test('storage breakdown: sharing and browsing a folder imports no file bytes', async (t) => {
  t.timeout(scaled(120000))
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).personKey
  const aBefore = await A.request('storage:info')
  const bBefore = await B.request('storage:info')

  const FILES = 500_000
  const share = await A.request('share:create', { spaceId, name: 'Notes' })
  const folder = mkTmpDir(t)
  fs.writeFileSync(path.join(folder, 'a.bin'), Buffer.alloc(300_000, 1))
  fs.writeFileSync(path.join(folder, 'b.bin'), Buffer.alloc(200_000, 2))

  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  await scanDone

  const aAfter = await A.request('storage:info')
  t.is(aAfter.indexBytes + aAfter.dbBytes, aAfter.totalDiskUsage, 'the owner breakdown sums to its total')
  t.ok(aAfter.totalDiskUsage - aBefore.totalDiskUsage < FILES / 2, 'the owner imported no file bytes')

  await B.until(
    'share:list-files',
    { spaceId, ownerKey: aKey, shareId: share.id },
    (f) => Array.isArray(f?.entries) && f.entries.length >= 2,
  )

  const bAfter = await B.request('storage:info')
  t.ok(bAfter.totalDiskUsage - bBefore.totalDiskUsage < FILES / 2, 'a peer replicating the catalog holds no file bytes')
})
