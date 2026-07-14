import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, waitForFile } from '../helpers/fixtures.js'

// FIX-360 (flow) — the share file limit is an ADMISSION gate, not a runtime ceiling. A folder
// admitted at exactly the limit that then GROWS past it must keep syncing every file to a mirroring
// peer. The alternative — silently refusing to publish past the limit — would leave the folder
// incomplete on every peer, which is a far worse failure than a truncated list: the owner sees a
// folder they believe is shared, and the member is quietly missing files. This proves the publish
// path (watcher add) never consults the limit, end to end across two real peers.
test('a folder that grows past the file limit still syncs every file to a mirror', { timeout: 150000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  // Alice is admitted at exactly the limit (4 files), then grows to 6.
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', flags: { maxFilesPerShare: 4 } })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey

  const share = await A.request('share:create', { spaceId, name: 'Grow' })
  const folder = mkTmpDir(t)
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(folder, 'f' + i + '.txt'), 'seed-' + i)

  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  await scanDone

  await B.until('share:list', { spaceId }, (l) => l.some((s) => s.id === share.id))
  const mirrorDir = mkTmpDir(t)
  const active = B.waitFor('event:foreign-folder-mount-status',
    (m) => m.shareId === share.id && m.status === 'active', 90000)
  await B.request('foreign-folder:mount', { spaceId, shareId: share.id, ownerKey: aKey, mountPath: mirrorDir })
  await active
  await waitForFile(path.join(mirrorDir, 'f0.txt'), { present: true })

  // Grow the folder PAST the limit. Every one of these must still publish and reach the mirror.
  for (let i = 4; i < 6; i++) {
    const abs = path.join(folder, 'f' + i + '.txt')
    fs.writeFileSync(abs, 'grown-' + i)
    await A.request('event:owned-folder-fs-event', { shareId: share.id, action: 'add', relPath: 'f' + i + '.txt', absPath: abs })
  }

  await waitForFile(path.join(mirrorDir, 'f4.txt'), { present: true, ms: 120000 })
  await waitForFile(path.join(mirrorDir, 'f5.txt'), { present: true, ms: 120000 })

  for (let i = 0; i < 6; i++) {
    t.ok(fs.existsSync(path.join(mirrorDir, 'f' + i + '.txt')), 'f' + i + '.txt reached the mirror')
  }
  t.is(fs.readFileSync(path.join(mirrorDir, 'f5.txt'), 'utf8'), 'grown-5', 'the file published past the limit is byte-exact')
})
