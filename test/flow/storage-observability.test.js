import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'

// Overlay serves straight from the source file, so it copies NO bytes into the
// per-space drive: a space's only retained bytes are its metadata core. This
// two-peer test covers what only a real run can: the per-space breakdown crossing
// the worker IPC reports zero drive content on both the owner and a browsing peer.
test('storage breakdown: a space reports no drive content (overlay serves in place)', async (t) => {
  t.timeout(120000)
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey

  const share = await A.request('share:create', { spaceId, name: 'Notes' })
  const folder = mkTmpDir(t)
  fs.writeFileSync(path.join(folder, 'a.bin'), Buffer.alloc(300_000, 1))
  fs.writeFileSync(path.join(folder, 'b.bin'), Buffer.alloc(200_000, 2))

  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  await scanDone

  const aSpace = (await A.request('storage:info')).spaces.find((s) => s.spaceId === spaceId)
  t.ok(aSpace, 'owner space appears in the breakdown')
  t.is(aSpace.contentBytes, 0, 'overlay copies no bytes into the per-space drive')
  t.is(aSpace.totalBytes, aSpace.metadataBytes + aSpace.contentBytes, 'totalBytes = metadata + content')

  await B.until(
    'share:list-files',
    { spaceId, ownerKey: aKey, shareId: share.id },
    (f) => Array.isArray(f?.entries) && f.entries.length >= 2,
  )

  const bSpace = (await B.request('storage:info')).spaces.find((s) => s.spaceId === spaceId)
  t.ok(bSpace, 'the space appears in the peer breakdown')
  t.is(bSpace.contentBytes, 0, 'a peer replicating the catalog holds no drive blobs')
})
