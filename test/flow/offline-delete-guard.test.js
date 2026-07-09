import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, waitForFile } from '../helpers/fixtures.js'

// CRIT-3 (flow) — the offline deletion guard (FIX-6 negative) end-to-end. When the
// owner goes offline, the materialize tick must NOT remove the user's mirrored
// files: a stale or momentarily-empty owner listing while the owner is offline is
// never treated as "owner deleted everything." foreign-sync proves the online
// positive and path-keys unit-tests the `shouldHonorDeletions` truth table; this
// proves the genuine offline path across two workers — files survive offline ticks.
test('an offline owner never causes the mirror to wipe already-synced files', { timeout: 180000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey

  const share = await A.request('share:create', { spaceId, name: 'Docs' })
  const folder = mkTmpDir(t)
  fs.writeFileSync(path.join(folder, 'keep1.txt'), 'one')
  fs.writeFileSync(path.join(folder, 'keep2.txt'), 'two')
  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  await scanDone

  // B mirrors → both files land and become tracked (syncedPaths).
  await B.until('share:list', { spaceId }, (l) => l.some((s) => s.id === share.id))
  const mirrorDir = mkTmpDir(t)
  const active = B.waitFor('event:foreign-folder-mount-status',
    (m) => m.shareId === share.id && m.status === 'active', 90000)
  await B.request('foreign-folder:mount', { spaceId, shareId: share.id, ownerKey: aKey, mountPath: mirrorDir })
  await active
  await waitForFile(path.join(mirrorDir, 'keep1.txt'), { present: true })
  await waitForFile(path.join(mirrorDir, 'keep2.txt'), { present: true })

  // Owner goes offline; B observes the drop.
  A.kill()
  await B.until('members:online', { spaceId }, (o) => !o.includes(aKey), { ms: 90000 })

  // Let at least one offline materialize tick run (POLL_INTERVAL is 30s). With the
  // owner offline the guard refuses every deletion, so the mirror is left intact.
  await new Promise((r) => setTimeout(r, 40000))
  t.ok(fs.existsSync(path.join(mirrorDir, 'keep1.txt')), 'first mirrored file survives offline ticks')
  t.ok(fs.existsSync(path.join(mirrorDir, 'keep2.txt')), 'second mirrored file survives offline ticks')
})
