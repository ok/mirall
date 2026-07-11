import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes, waitForFile } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

const FLAGS = { overlayEnabled: true }

// Poll a mirrored file's CONTENT (waitForFile only checks presence) until it
// matches, or fail — for asserting the mirror re-fetched an owner edit.
async function waitForContent (file, want, ms = scaled(70000)) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try { if (fs.readFileSync(file).equals(want)) return } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`content at ${file} never matched (${want.length}B) within ${ms}ms`)
}

// Ongoing overlay mirror sync: after the initial mirror is active, an owner EDIT
// must re-fetch (the new content hash differs, so materializeOverlayFile pulls
// it), and an owner DELETE must remove the file from the mirror — while unrelated
// files stay. Mirrors mirror-add (eager) / foreign-sync, for the overlay backend.
// Owner FS events are injected via the IPC the chokidar watcher uses in production;
// the consumer picks changes up on its periodic materialize tick.
test('overlay mirror: re-fetches on owner edit and removes on owner delete',
  { timeout: scaled(180000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: mkTmpDir(t), flags: FLAGS })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', downloads: mkTmpDir(t), flags: FLAGS })
    const spaceId = await connectInSpace(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    const share = await A.request('share:create', { spaceId, name: 'Mirror', contentMode: 'overlay' })
    const folder = mkTmpDir(t)
    const v1 = Buffer.from('v1')
    const keep = patternedBytes(8 * 1024, 4)
    fs.writeFileSync(path.join(folder, 'doc.txt'), v1)
    fs.writeFileSync(path.join(folder, 'keep.bin'), keep)
    const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
    await scanDone

    await B.until('share:list', { spaceId }, (l) => Array.isArray(l) && l.some((s) => s.id === share.id), { ms: 60000 })
    const dest = mkTmpDir(t)
    const active = B.waitFor('event:foreign-folder-mount-status', (m) => m.shareId === share.id && m.status === 'active', 90000)
    await B.request('foreign-folder:mount', { spaceId, ownerKey: aKey, shareId: share.id, mountPath: dest })
    await active

    // Initial mirror: both files land via overlay fetch-to-mount.
    await waitForContent(path.join(dest, 'doc.txt'), v1)
    await waitForFile(path.join(dest, 'keep.bin'), { present: true, ms: 70000 })
    t.ok(fs.readFileSync(path.join(dest, 'keep.bin')).equals(keep), 'keep.bin mirrored byte-exact')

    // Owner EDITS doc.txt → new content hash → mirror must re-fetch v2.
    const v2 = Buffer.from('v2 — edited, a clearly different length than v1')
    fs.writeFileSync(path.join(folder, 'doc.txt'), v2)
    await A.request('event:owned-folder-fs-event', { shareId: share.id, action: 'add', relPath: 'doc.txt', absPath: path.join(folder, 'doc.txt') })
    await waitForContent(path.join(dest, 'doc.txt'), v2)
    t.pass('owner edit re-fetched on the overlay mirror')

    // Owner DELETES doc.txt → mirror removes it; keep.bin stays.
    fs.unlinkSync(path.join(folder, 'doc.txt'))
    await A.request('event:owned-folder-fs-event', { shareId: share.id, action: 'unlink', relPath: 'doc.txt', absPath: path.join(folder, 'doc.txt') })
    await waitForFile(path.join(dest, 'doc.txt'), { present: false, ms: 70000 })
    t.absent(fs.existsSync(path.join(dest, 'doc.txt')), 'owner delete removed the file from the overlay mirror')
    t.ok(fs.existsSync(path.join(dest, 'keep.bin')), 'unrelated mirrored file kept')
  })
