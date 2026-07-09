import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, waitForFile } from '../helpers/fixtures.js'

// REGRESSION (FIX: multi-space owned share) — the same on-disk folder shared into
// two different spaces must (1) mount in both without MOUNT_OVERLAPS, and (2)
// publish + propagate edits/deletes to each space's mirror independently. Before
// the mount-validate relaxation, step (1) threw "already being shared or mirrored".
test('one folder shared into two spaces reaches a mirror in each, independently', { timeout: 240000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const C = await launchPeer(t, { bootstrap, displayName: 'Carol' })
  const aKey = (await A.request('profile:get')).publicKey

  const space1 = await connectInSpace(t, A, B, 'Space One')
  const space2 = await connectInSpace(t, A, C, 'Space Two')

  const folder = mkTmpDir(t)
  fs.writeFileSync(path.join(folder, 'keep.txt'), 'v1')
  fs.writeFileSync(path.join(folder, 'doomed.txt'), 'temporary')

  const s1 = await A.request('share:create', { spaceId: space1, name: 'Shared' })
  const scan1 = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === s1.id)
  await A.request('owned-folder:mount', { spaceId: space1, shareId: s1.id, mountPath: folder })
  await scan1

  // The previously-failing call: same `folder`, a second space → must NOT throw.
  const s2 = await A.request('share:create', { spaceId: space2, name: 'Shared' })
  const scan2 = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === s2.id)
  await A.request('owned-folder:mount', { spaceId: space2, shareId: s2.id, mountPath: folder })
  await scan2
  t.pass('same folder mounted into a second space without MOUNT_OVERLAPS')

  async function mirror (peer, spaceId, shareId) {
    await peer.until('share:list', { spaceId }, (l) => l.some((s) => s.id === shareId), { ms: 90000 })
    const dir = mkTmpDir(t)
    const active = peer.waitFor('event:foreign-folder-mount-status',
      (m) => m.shareId === shareId && m.status === 'active', 120000)
    await peer.request('foreign-folder:mount', { spaceId, shareId, ownerKey: aKey, mountPath: dir })
    await active
    await waitForFile(path.join(dir, 'keep.txt'), { present: true })
    await waitForFile(path.join(dir, 'doomed.txt'), { present: true })
    return dir
  }
  const dirB = await mirror(B, space1, s1.id)
  const dirC = await mirror(C, space2, s2.id)

  // Owner edits keep.txt and deletes doomed.txt ONCE on disk; both shares' watchers
  // see it in production — model that by firing the fs-event for each shareId.
  fs.writeFileSync(path.join(folder, 'keep.txt'), 'v2-edited')
  fs.rmSync(path.join(folder, 'doomed.txt'))
  for (const shareId of [s1.id, s2.id]) {
    await A.request('event:owned-folder-fs-event',
      { shareId, action: 'change', relPath: 'keep.txt', absPath: path.join(folder, 'keep.txt') })
    await A.request('event:owned-folder-fs-event',
      { shareId, action: 'unlink', relPath: 'doomed.txt', absPath: path.join(folder, 'doomed.txt') })
  }

  for (const [label, dir] of [['space1/B', dirB], ['space2/C', dirC]]) {
    await waitForFile(path.join(dir, 'doomed.txt'), { present: false, ms: 150000 })
    await waitForFile(path.join(dir, 'keep.txt'), { present: true })
    const start = Date.now()
    while (fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8') !== 'v2-edited') {
      if (Date.now() - start > 60000) break
      await new Promise((r) => setTimeout(r, 500))
    }
    t.is(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'v2-edited', `${label}: edit propagated`)
    t.absent(fs.existsSync(path.join(dir, 'doomed.txt')), `${label}: delete propagated`)
  }
})
