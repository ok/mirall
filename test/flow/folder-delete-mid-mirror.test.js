import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes, waitForFile } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// Owner removes folder content WHILE a peer is actively mirroring it (not idle / already
// synced). share-delete and subfolder-delete cover deletions of already-materialized files;
// these fire the removal right after the mirror goes active, so a large file is still
// materializing. FE s89/s90. The deterministic guarantees are the peer-visible outcome
// (share tombstone / file removed, sibling preserved); early completion before the removal
// lands is logged, not failed (a legitimate race, matching the FE altitude).
const sleep = (ms) => new Promise((r) => setTimeout(r, scaled(ms)))

async function ownedShareWithScan (A, spaceId, name, folder) {
  const share = await A.request('share:create', { spaceId, name })
  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  await scanDone
  return share
}
async function mirror (t, A, B, spaceId, share, aKey) {
  await B.until('share:list', { spaceId }, (l) => l.some((s) => s.id === share.id))
  const mirrorDir = mkTmpDir(t)
  const active = B.waitFor('event:foreign-folder-mount-status', (m) => m.shareId === share.id && m.status === 'active', scaled(90000))
  await B.request('foreign-folder:mount', { spaceId, shareId: share.id, ownerKey: aKey, mountPath: mirrorDir })
  await active
  return mirrorDir
}

// C2 — owner deletes the whole share while the peer is mirroring a large file.
test('owner deletes the share mid-mirror: the share tombstones on the mirroring peer',
  { timeout: scaled(180000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
    const spaceId = await connectInSpace(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    const folder = mkTmpDir(t)
    const big = patternedBytes(64 * 1024 * 1024, 7)
    fs.writeFileSync(path.join(folder, 'big.bin'), big)
    const share = await ownedShareWithScan(A, spaceId, 'Vault', folder)
    const mirrorDir = await mirror(t, A, B, spaceId, share, aKey)

    // Delete right after the mount goes active — the 64 MB file is still materializing.
    await A.request('owned-folder:delete', { spaceId, shareId: share.id })

    await B.until('share:list', { spaceId }, (l) => !l.some((s) => s.id === share.id), { ms: scaled(60000) })
    t.pass('share tombstone reached the mirroring peer')

    await sleep(3000)
    const target = path.join(mirrorDir, 'big.bin')
    const full = fs.existsSync(target) && fs.statSync(target).size === big.length
    t.comment(`big.bin fully materialized before the delete took effect: ${full}`)
    A.kill()
  })

// C3 — owner deletes a single file (fs-event unlink) mid-mirror; a sibling is preserved.
test('owner deletes a file mid-mirror: it is removed from the mirror, the sibling is preserved',
  { timeout: scaled(180000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
    const spaceId = await connectInSpace(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    const folder = mkTmpDir(t)
    fs.writeFileSync(path.join(folder, 'big.bin'), patternedBytes(64 * 1024 * 1024, 9))
    fs.writeFileSync(path.join(folder, 'keep.txt'), 'survivor')
    const share = await ownedShareWithScan(A, spaceId, 'Docs', folder)
    const mirrorDir = await mirror(t, A, B, spaceId, share, aKey)

    // Delete big.bin on disk + inject its unlink while the mirror is materializing.
    fs.rmSync(path.join(folder, 'big.bin'))
    await A.request('event:owned-folder-fs-event', { shareId: share.id, action: 'unlink', relPath: 'big.bin', absPath: path.join(folder, 'big.bin') })

    await waitForFile(path.join(mirrorDir, 'big.bin'), { present: false, ms: scaled(120000) })
    await waitForFile(path.join(mirrorDir, 'keep.txt'), { present: true, ms: scaled(90000) })
    t.absent(fs.existsSync(path.join(mirrorDir, 'big.bin')), 'the deleted file is removed from the mirror')
    t.ok(fs.existsSync(path.join(mirrorDir, 'keep.txt')), 'the sibling file is preserved')
    A.kill()
  })
