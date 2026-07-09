import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'

async function waitForFile (p, { present = true, ms = 90000, every = 500 } = {}) {
  const start = Date.now()
  for (;;) {
    if (fs.existsSync(p) === present) return
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${p} present=${present}`)
    await new Promise((r) => setTimeout(r, every))
  }
}

// owned-folder:delete is the owner's full teardown: it stops the watcher +
// reconcile, dels every drive entry under the share prefix, removes the owned
// mount, and tombstones the share. On a peer, the tombstone hides the folder.
// The emptied drive listing must NOT wipe the peer's mirror (an empty listing
// is the FIX-6 "treat as transient" case) — those files persist as orphans,
// exactly like an unmount.
test('owner deletes a share: it vanishes from the peer registry and the mirror files orphan (not wiped)',
  { timeout: 150000 }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
    const spaceId = await connectInSpace(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    const share = await A.request('share:create', { spaceId, name: 'Notes' })
    const folder = mkTmpDir(t)
    fs.writeFileSync(path.join(folder, 'one.txt'), 'hello')
    fs.writeFileSync(path.join(folder, 'two.txt'), 'world')
    const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
    await scanDone

    // B mirrors → both files land.
    await B.until('share:list', { spaceId }, (l) => l.some((s) => s.id === share.id))
    const mirrorDir = mkTmpDir(t)
    const active = B.waitFor('event:foreign-folder-mount-status',
      (m) => m.shareId === share.id && m.status === 'active', 90000)
    await B.request('foreign-folder:mount', { spaceId, shareId: share.id, ownerKey: aKey, mountPath: mirrorDir })
    await active
    await waitForFile(path.join(mirrorDir, 'one.txt'), { present: true })

    // Owner deletes the share.
    await A.request('owned-folder:delete', { spaceId, shareId: share.id })

    // Owner side: mount gone, share gone from own registry.
    t.is(await A.request('owned-folder:get', { spaceId, shareId: share.id }), null, 'owned mount removed')
    t.absent((await A.request('share:list', { spaceId })).some((s) => s.id === share.id), 'gone from owner registry')

    // Peer side: the tombstone propagates and the folder disappears from B.
    await B.until('share:list', { spaceId }, (l) => !l.some((s) => s.id === share.id), { ms: 60000 })
    t.pass('share tombstone propagated to peer')

    // But the already-mirrored files are NOT deleted from B's disk — an emptied
    // owner listing is the FIX-6 transient case, so the mirror orphans them.
    await new Promise((r) => setTimeout(r, 1000))
    t.ok(fs.existsSync(path.join(mirrorDir, 'one.txt')), 'mirrored file orphaned on disk, not wiped')
    t.ok(fs.existsSync(path.join(mirrorDir, 'two.txt')), 'second mirrored file orphaned on disk, not wiped')
  })
