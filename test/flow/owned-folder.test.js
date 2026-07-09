import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'

test('A publishes an owned folder; the share + its files replicate to B', async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey

  // A creates a share and mounts a folder that already contains files.
  const share = await A.request('share:create', { spaceId, name: 'Notes' })
  const folder = mkTmpDir(t)
  fs.writeFileSync(path.join(folder, 'one.txt'), 'hello')
  fs.writeFileSync(path.join(folder, 'two.txt'), 'world')

  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  const scan = await scanDone
  t.is(scan.uploaded, 2, 'both files published by the initial scan')

  // The share registry rides the profile bee → B sees it.
  const shares = await B.until('share:list', { spaceId }, (list) => list.some((s) => s.id === share.id))
  const seen = shares.find((s) => s.id === share.id)
  t.is(seen.name, 'Notes')
  t.is(seen.owner, aKey)
  t.is(seen.type, 'owned-folder')

  // B can list the folder's files (read from A's replicated drive).
  const files = await B.until(
    'share:list-files',
    { spaceId, ownerKey: aKey, shareId: share.id },
    (f) => Array.isArray(f?.entries) && f.entries.length >= 2,
  )
  t.alike(files.entries.map((f) => f.relPath).sort(), ['one.txt', 'two.txt'])

  // Deleting the share tombstones it → B stops seeing it.
  await A.request('share:delete', { spaceId, shareId: share.id })
  await B.until('share:list', { spaceId }, (list) => !list.some((s) => s.id === share.id))
  t.pass('share disappears from B after tombstone')
})
