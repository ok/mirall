import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes, waitForFile } from '../helpers/fixtures.js'

// CRIT-1 (flow) — every other folder test uses a flat folder. This is the base
// case: a shared folder containing subfolders must publish its nested files
// (relPath with `/`) and a mirror must recreate the directory tree byte-exact.
// The relPath⇄key separator math is unit-proven (path-keys); this exercises the
// real scan→replicate→materialize pipeline for nested paths across two workers.
test('a nested folder tree publishes and materializes with structure intact', { timeout: 120000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey

  const share = await A.request('share:create', { spaceId, name: 'Tree' })
  const folder = mkTmpDir(t)
  const rootBytes = patternedBytes(4096, 3)
  const aBytes = patternedBytes(8192, 5)
  const deepBytes = patternedBytes(16384, 9)
  fs.writeFileSync(path.join(folder, 'root.txt'), rootBytes)
  fs.mkdirSync(path.join(folder, 'sub', 'deep'), { recursive: true })
  fs.writeFileSync(path.join(folder, 'sub', 'a.txt'), aBytes)
  fs.writeFileSync(path.join(folder, 'sub', 'deep', 'b.bin'), deepBytes)

  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  t.is((await scanDone).uploaded, 3, 'all three nested files published by the initial scan')

  // The replicated file list preserves the nested relPaths.
  const files = await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
    (f) => Array.isArray(f?.entries) && f.entries.length === 3)
  t.alike(files.entries.map((f) => f.relPath).sort(), ['root.txt', 'sub/a.txt', 'sub/deep/b.bin'],
    'nested relPaths replicate intact')

  // B mirrors → the tree is recreated on disk, byte-exact.
  await B.until('share:list', { spaceId }, (l) => l.some((s) => s.id === share.id))
  const mirrorDir = mkTmpDir(t)
  const active = B.waitFor('event:foreign-folder-mount-status',
    (m) => m.shareId === share.id && m.status === 'active', 90000)
  await B.request('foreign-folder:mount', { spaceId, shareId: share.id, ownerKey: aKey, mountPath: mirrorDir })
  await active

  await waitForFile(path.join(mirrorDir, 'sub', 'deep', 'b.bin'), { present: true })
  t.ok(fs.readFileSync(path.join(mirrorDir, 'root.txt')).equals(rootBytes), 'root file byte-exact')
  t.ok(fs.readFileSync(path.join(mirrorDir, 'sub', 'a.txt')).equals(aBytes), 'subfolder file byte-exact')
  t.ok(fs.readFileSync(path.join(mirrorDir, 'sub', 'deep', 'b.bin')).equals(deepBytes), 'deep subfolder file byte-exact')
})
