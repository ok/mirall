import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace, addPeerToSpace } from '../helpers/peer.js'
import { mkTmpDir, waitForFile } from '../helpers/fixtures.js'

// CRIT-8 (flow) — two peers (B and C) both mirror the SAME owner folder. An owner
// edit and an owner delete must reach BOTH mirrors independently. The suite's
// first multi-mirror scenario: if one mirror diverges (misses an edit or delete),
// the two peers silently disagree on the folder's contents.
test('an owner edit and delete reach two independent mirrors of the same folder', { timeout: 240000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const C = await launchPeer(t, { bootstrap, displayName: 'Carol' })
  const spaceId = await connectInSpace(t, A, B)
  await addPeerToSpace(A, C, spaceId)
  const aKey = (await A.request('profile:get')).publicKey

  const share = await A.request('share:create', { spaceId, name: 'Shared' })
  const folder = mkTmpDir(t)
  fs.writeFileSync(path.join(folder, 'keep.txt'), 'v1')
  fs.writeFileSync(path.join(folder, 'doomed.txt'), 'temporary')
  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  await scanDone

  // Both B and C mirror the folder into their own dirs.
  const mirrors = await Promise.all([B, C].map(async (peer) => {
    await peer.until('share:list', { spaceId }, (l) => l.some((s) => s.id === share.id), { ms: 90000 })
    const dir = mkTmpDir(t)
    const active = peer.waitFor('event:foreign-folder-mount-status',
      (m) => m.shareId === share.id && m.status === 'active', 120000)
    await peer.request('foreign-folder:mount', { spaceId, shareId: share.id, ownerKey: aKey, mountPath: dir })
    await active
    await waitForFile(path.join(dir, 'keep.txt'), { present: true })
    await waitForFile(path.join(dir, 'doomed.txt'), { present: true })
    return dir
  }))

  // Owner edits keep.txt and deletes doomed.txt.
  fs.writeFileSync(path.join(folder, 'keep.txt'), 'v2-edited')
  await A.request('event:owned-folder-fs-event',
    { shareId: share.id, action: 'change', relPath: 'keep.txt', absPath: path.join(folder, 'keep.txt') })
  fs.rmSync(path.join(folder, 'doomed.txt'))
  await A.request('event:owned-folder-fs-event',
    { shareId: share.id, action: 'unlink', relPath: 'doomed.txt', absPath: path.join(folder, 'doomed.txt') })

  // Each mirror independently converges: keep edited, doomed gone.
  for (let i = 0; i < mirrors.length; i++) {
    const dir = mirrors[i]
    await waitForFile(path.join(dir, 'doomed.txt'), { present: false, ms: 150000 })
    await waitForFile(path.join(dir, 'keep.txt'), { present: true })
    // The edit can land slightly after the file reappears; settle on the content.
    const start = Date.now()
    while (fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8') !== 'v2-edited') {
      if (Date.now() - start > 60000) break
      await new Promise((r) => setTimeout(r, 500))
    }
    t.is(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'v2-edited', `mirror ${i}: edit propagated`)
    t.absent(fs.existsSync(path.join(dir, 'doomed.txt')), `mirror ${i}: delete propagated`)
  }
})
