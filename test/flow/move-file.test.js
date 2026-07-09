import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes, waitForFile } from '../helpers/fixtures.js'

// CRIT-5 (flow) — moving a file from the folder root into a subfolder is an
// unlink (old path) + add (new path) to the watcher. It must reach the mirror as
// remove-old + create-new, byte-preserved, with no duplicate and no window where
// the content is lost. Explicitly named ("moving files in subfolders").
test('moving a file into a subfolder removes the old path and creates the new on the mirror', { timeout: 150000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey

  const share = await A.request('share:create', { spaceId, name: 'Docs' })
  const folder = mkTmpDir(t)
  const bytes = patternedBytes(12 * 1024, 7)
  fs.writeFileSync(path.join(folder, 'doc.bin'), bytes)
  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  await scanDone

  await B.until('share:list', { spaceId }, (l) => l.some((s) => s.id === share.id))
  const mirrorDir = mkTmpDir(t)
  const active = B.waitFor('event:foreign-folder-mount-status',
    (m) => m.shareId === share.id && m.status === 'active', 90000)
  await B.request('foreign-folder:mount', { spaceId, shareId: share.id, ownerKey: aKey, mountPath: mirrorDir })
  await active
  await waitForFile(path.join(mirrorDir, 'doc.bin'), { present: true })

  // Owner moves doc.bin → archive/doc.bin (unlink old, add new). The destination
  // file must exist before the unlink event so the unlink is a genuine delete.
  fs.mkdirSync(path.join(folder, 'archive'), { recursive: true })
  fs.renameSync(path.join(folder, 'doc.bin'), path.join(folder, 'archive', 'doc.bin'))
  await A.request('event:owned-folder-fs-event',
    { shareId: share.id, action: 'add', relPath: 'archive/doc.bin', absPath: path.join(folder, 'archive', 'doc.bin') })
  await A.request('event:owned-folder-fs-event',
    { shareId: share.id, action: 'unlink', relPath: 'doc.bin', absPath: path.join(folder, 'doc.bin') })

  // Mirror reflects the move: new path appears, old path is gone, no duplicate.
  await waitForFile(path.join(mirrorDir, 'archive', 'doc.bin'), { present: true, ms: 120000 })
  await waitForFile(path.join(mirrorDir, 'doc.bin'), { present: false, ms: 120000 })
  t.ok(fs.readFileSync(path.join(mirrorDir, 'archive', 'doc.bin')).equals(bytes), 'moved file byte-exact at the new path')
  t.absent(fs.existsSync(path.join(mirrorDir, 'doc.bin')), 'old path removed (no duplicate left behind)')
})
