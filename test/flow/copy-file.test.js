import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes, waitForFile } from '../helpers/fixtures.js'

// CRIT-6 (flow) — copying a file within a shared folder produces a second path
// holding identical bytes. Both must replicate and the mirror must materialize
// both. The collision-naming walk is unit-proven (path-keys); this is the byte /
// blob path: two drive keys, identical content, both landing on the mirror.
test('copying a file yields two byte-identical paths on the mirror', { timeout: 150000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey

  const share = await A.request('share:create', { spaceId, name: 'Docs' })
  const folder = mkTmpDir(t)
  const bytes = patternedBytes(20 * 1024, 13)
  fs.writeFileSync(path.join(folder, 'orig.bin'), bytes)
  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  await scanDone

  await B.until('share:list', { spaceId }, (l) => l.some((s) => s.id === share.id))
  const mirrorDir = mkTmpDir(t)
  const active = B.waitFor('event:foreign-folder-mount-status',
    (m) => m.shareId === share.id && m.status === 'active', 90000)
  await B.request('foreign-folder:mount', { spaceId, shareId: share.id, ownerKey: aKey, mountPath: mirrorDir })
  await active
  await waitForFile(path.join(mirrorDir, 'orig.bin'), { present: true })

  // Owner copies orig.bin → copy.bin (identical bytes) and adds it.
  fs.copyFileSync(path.join(folder, 'orig.bin'), path.join(folder, 'copy.bin'))
  await A.request('event:owned-folder-fs-event',
    { shareId: share.id, action: 'add', relPath: 'copy.bin', absPath: path.join(folder, 'copy.bin') })

  // Both paths materialize on the mirror with identical bytes, and the original
  // is untouched.
  await waitForFile(path.join(mirrorDir, 'copy.bin'), { present: true, ms: 120000 })
  const orig = fs.readFileSync(path.join(mirrorDir, 'orig.bin'))
  const copy = fs.readFileSync(path.join(mirrorDir, 'copy.bin'))
  t.ok(orig.equals(bytes), 'original path still byte-exact')
  t.ok(copy.equals(bytes), 'copied path byte-exact')
  t.ok(orig.equals(copy), 'both mirrored paths hold identical content')

  // Both are present in the replicated listing as distinct entries.
  const files = await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
    (f) => Array.isArray(f?.entries) && f.entries.some((e) => e.relPath === 'copy.bin'))
  t.alike(files.entries.map((f) => f.relPath).sort(), ['copy.bin', 'orig.bin'], 'two distinct drive entries for the copy')
})
