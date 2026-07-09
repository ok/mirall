import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { MODES } from '../helpers/modes.js'

const FLAGS = { overlayEnabled: true }

for (const mode of MODES) {
// Leftover connection data only exists after a real prior connection: Bob browses
// Alice's overlay share, so her replicated catalog lands in his store. When Bob
// leaves, the drives and Alice's profile are purged (Option C), but her catalog
// is not — it is the leftover the Storage action must scan and clean.
test(`a past peer’s leftover catalog is scannable and cleanable after leaving [${mode.name}]`, { timeout: 150000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  // Use the harness default storage (a nested <unique>/app-storage), so identity.enc
  // is isolated per peer; a flat mkTmpDir would collide it in the shared tmp root.
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', flags: { ...FLAGS, ...mode.flags() } })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', flags: { ...FLAGS, ...mode.flags() } })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey

  const share = await A.request('share:create', { spaceId, name: 'Photos', contentMode: 'overlay' })
  const folder = mkTmpDir(t)
  fs.writeFileSync(path.join(folder, 'big.bin'), patternedBytes(64 * 1024, 7))
  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  await scanDone

  // Bob browses Alice's share — this opens and replicates her catalog into his store.
  await B.until('share:list', { spaceId }, (list) => list.some((s) => s.id === share.id))
  await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
    (files) => !!files?.entries?.some((e) => e.relPath === 'big.bin'), { ms: 30000 })

  await B.request('space:leave', { spaceId })

  const scan = await B.request('storage:leftover-scan')
  t.ok(scan.profiles.count + scan.catalogs.count >= 1, 'a past peer’s leftover core is found')

  await B.request('storage:free-space')

  const after = await B.request('storage:leftover-scan')
  t.is(after.profiles.count, 0, 'no leftover profiles remain')
  t.is(after.catalogs.count, 0, 'no leftover catalogs remain')

  A.kill()
  B.kill()
})
}
