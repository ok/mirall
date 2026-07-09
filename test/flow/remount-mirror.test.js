import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes, waitForFile } from '../helpers/fixtures.js'

// CRIT-11 (flow) — unmounting a mirror reclaims its cached blobs (FIX-9). The
// inverse must also hold: mounting it again re-materializes the files cleanly,
// re-fetching from the owner since the cache was reclaimed. Guards against a
// remount that errors or never re-downloads.
test('remounting a previously-unmounted mirror re-materializes the files', { timeout: 150000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey

  const share = await A.request('share:create', { spaceId, name: 'Media' })
  const folder = mkTmpDir(t)
  const bytes = patternedBytes(24 * 1024, 9)
  fs.writeFileSync(path.join(folder, 'clip.bin'), bytes)
  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  await scanDone

  await B.until('share:list', { spaceId }, (l) => l.some((s) => s.id === share.id))
  const mirrorDir = mkTmpDir(t)
  const active1 = B.waitFor('event:foreign-folder-mount-status',
    (m) => m.shareId === share.id && m.status === 'active', 90000)
  await B.request('foreign-folder:mount', { spaceId, shareId: share.id, ownerKey: aKey, mountPath: mirrorDir })
  await active1
  await waitForFile(path.join(mirrorDir, 'clip.bin'), { present: true })

  // Unmount, then clear the on-disk copy so a successful remount can only mean a
  // genuine re-materialize (the reclaimed cache forces a re-fetch from the owner).
  await B.request('foreign-folder:unmount', { spaceId, shareId: share.id })
  fs.rmSync(path.join(mirrorDir, 'clip.bin'), { force: true })
  t.absent(fs.existsSync(path.join(mirrorDir, 'clip.bin')), 'mirror file cleared after unmount')

  // Mount again at the same dir → the file comes back, byte-exact.
  const active2 = B.waitFor('event:foreign-folder-mount-status',
    (m) => m.shareId === share.id && m.status === 'active', 90000)
  await B.request('foreign-folder:mount', { spaceId, shareId: share.id, ownerKey: aKey, mountPath: mirrorDir })
  await active2
  await waitForFile(path.join(mirrorDir, 'clip.bin'), { present: true, ms: 120000 })
  t.ok(fs.readFileSync(path.join(mirrorDir, 'clip.bin')).equals(bytes), 're-materialized byte-exact after remount')
})
