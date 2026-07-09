import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes, waitForFile } from '../helpers/fixtures.js'

// CRIT-4 (flow) — adding a brand-new file to a shared folder AFTER a mirror is
// already active must propagate to the mirror. foreign-sync proves edit + delete
// after mount; the single most common ongoing action — a fresh add (at the root
// and inside a subfolder) — was never covered.
test('files added after the mirror is active materialize on the mirror', { timeout: 150000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey

  const share = await A.request('share:create', { spaceId, name: 'Docs' })
  const folder = mkTmpDir(t)
  fs.writeFileSync(path.join(folder, 'keep.txt'), 'seed')
  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  await scanDone

  await B.until('share:list', { spaceId }, (l) => l.some((s) => s.id === share.id))
  const mirrorDir = mkTmpDir(t)
  const active = B.waitFor('event:foreign-folder-mount-status',
    (m) => m.shareId === share.id && m.status === 'active', 90000)
  await B.request('foreign-folder:mount', { spaceId, shareId: share.id, ownerKey: aKey, mountPath: mirrorDir })
  await active
  await waitForFile(path.join(mirrorDir, 'keep.txt'), { present: true })

  // Owner adds a new root file and a new file inside a fresh subfolder.
  const rootBytes = patternedBytes(6 * 1024, 5)
  const subBytes = patternedBytes(10 * 1024, 11)
  fs.writeFileSync(path.join(folder, 'added.bin'), rootBytes)
  fs.mkdirSync(path.join(folder, 'new'), { recursive: true })
  fs.writeFileSync(path.join(folder, 'new', 'nested.bin'), subBytes)
  await A.request('event:owned-folder-fs-event',
    { shareId: share.id, action: 'add', relPath: 'added.bin', absPath: path.join(folder, 'added.bin') })
  await A.request('event:owned-folder-fs-event',
    { shareId: share.id, action: 'add', relPath: 'new/nested.bin', absPath: path.join(folder, 'new', 'nested.bin') })

  await waitForFile(path.join(mirrorDir, 'added.bin'), { present: true, ms: 120000 })
  await waitForFile(path.join(mirrorDir, 'new', 'nested.bin'), { present: true, ms: 120000 })
  t.ok(fs.readFileSync(path.join(mirrorDir, 'added.bin')).equals(rootBytes), 'added root file materialized byte-exact')
  t.ok(fs.readFileSync(path.join(mirrorDir, 'new', 'nested.bin')).equals(subBytes), 'added nested file materialized byte-exact')
})
