import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, waitForFile } from '../helpers/fixtures.js'

// CRIT-2 (flow) — deleting a whole subfolder (several files) from a shared folder
// while a mirror is active (owner online) must remove that subtree from the mirror
// and nothing else. Recursive deletes are where "deleted the wrong thing" bugs
// live; foreign-sync covers only a single-file delete. The watcher fires one
// unlink per file under the removed subfolder, which we inject directly here.
test('deleting a subfolder removes its whole subtree from an online mirror, leaving siblings', { timeout: 150000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey

  const share = await A.request('share:create', { spaceId, name: 'Docs' })
  const folder = mkTmpDir(t)
  fs.writeFileSync(path.join(folder, 'keep.txt'), 'survivor')
  fs.mkdirSync(path.join(folder, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(folder, 'sub', 'x.txt'), 'doomed-x')
  fs.writeFileSync(path.join(folder, 'sub', 'y.txt'), 'doomed-y')
  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  await scanDone

  // B mirrors → the whole tree lands.
  await B.until('share:list', { spaceId }, (l) => l.some((s) => s.id === share.id))
  const mirrorDir = mkTmpDir(t)
  const active = B.waitFor('event:foreign-folder-mount-status',
    (m) => m.shareId === share.id && m.status === 'active', 90000)
  await B.request('foreign-folder:mount', { spaceId, shareId: share.id, ownerKey: aKey, mountPath: mirrorDir })
  await active
  await waitForFile(path.join(mirrorDir, 'sub', 'x.txt'), { present: true })
  await waitForFile(path.join(mirrorDir, 'sub', 'y.txt'), { present: true })

  // Owner deletes the whole subfolder on disk, then the watcher's per-file unlinks
  // arrive (root still present, so each is a genuine delete, not a moved-root).
  fs.rmSync(path.join(folder, 'sub'), { recursive: true, force: true })
  await A.request('event:owned-folder-fs-event',
    { shareId: share.id, action: 'unlink', relPath: 'sub/x.txt', absPath: path.join(folder, 'sub', 'x.txt') })
  await A.request('event:owned-folder-fs-event',
    { shareId: share.id, action: 'unlink', relPath: 'sub/y.txt', absPath: path.join(folder, 'sub', 'y.txt') })

  // The mirror (owner online, non-empty listing) honors both deletions...
  await waitForFile(path.join(mirrorDir, 'sub', 'x.txt'), { present: false, ms: 120000 })
  await waitForFile(path.join(mirrorDir, 'sub', 'y.txt'), { present: false, ms: 120000 })
  t.absent(fs.existsSync(path.join(mirrorDir, 'sub', 'x.txt')), 'subtree file x removed from mirror')
  t.absent(fs.existsSync(path.join(mirrorDir, 'sub', 'y.txt')), 'subtree file y removed from mirror')
  // ...but the sibling outside the deleted subfolder is untouched.
  t.ok(fs.existsSync(path.join(mirrorDir, 'keep.txt')), 'sibling file outside the subtree is preserved')
})
