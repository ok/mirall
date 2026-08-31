import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes, mkStoreDir } from '../helpers/fixtures.js'

async function waitForFile (p, { present = true, ms = 90000, every = 500 } = {}) {
  const start = Date.now()
  for (;;) {
    if (fs.existsSync(p) === present) return
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${p} present=${present}`)
    await new Promise((r) => setTimeout(r, every))
  }
}

// The materialize engine streams a blob from the owner on demand. If the owner
// is offline and the blob isn't cached, it must DEFER (try again next tick) —
// not skip forever (the old has()-only deadlock) and not error/pause. When the
// owner returns, the poll loop completes the download.
test('REGRESSION (connectivity gate): mirror defers while owner offline+uncached, then materializes on return',
  { timeout: 180000 }, async (t) => {
    const bootstrap = await localTestnet(t)
    const aStore = mkStoreDir(t)
    const aDownloads = mkTmpDir(t)
    let A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore, downloads: aDownloads })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
    const spaceId = await connectInSpace(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    const share = await A.request('share:create', { spaceId, name: 'Photos' })
    const folder = mkTmpDir(t)
    const bytes = patternedBytes(32 * 1024, 9)
    fs.writeFileSync(path.join(folder, 'pic.bin'), bytes)
    const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
    await scanDone

    // B learns the share AND its file metadata while A is online, but never
    // downloads the blob (no mirror yet) → metadata cached, blob uncached.
    await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
      (f) => Array.isArray(f?.entries) && f.entries.some((e) => e.relPath === 'pic.bin'), { ms: 60000 })

    // A goes offline.
    A.kill()
    await B.until('members:online', { spaceId }, (o) => !o.includes(aKey), { ms: 90000 })

    // B mounts the mirror while the owner is offline: the scan must complete
    // (status active) without paused-error, and the file must NOT be on disk yet.
    const mirrorDir = mkTmpDir(t)
    const active = B.waitFor('event:foreign-folder-mount-status',
      (m) => m.shareId === share.id && m.status === 'active', 60000)
    await B.request('foreign-folder:mount', { spaceId, shareId: share.id, ownerKey: aKey, mountPath: mirrorDir })
    await active
    t.absent(fs.existsSync(path.join(mirrorDir, 'pic.bin')), 'deferred — no file written while owner offline')

    // Owner returns with the same drive → the poll tick completes the download.
    A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore, downloads: aDownloads })
    await waitForFile(path.join(mirrorDir, 'pic.bin'), { present: true, ms: 120000 })
    t.ok(fs.readFileSync(path.join(mirrorDir, 'pic.bin')).equals(bytes), 'materialized byte-exact once owner back')
  })

// FIX-6 positive, through the real loop: with the owner online and a non-empty
// listing, an owner-side edit propagates to the mirror and an owner-side delete
// removes the mirrored file.
test('REGRESSION (FIX-6): owner edit and delete propagate to an online mirror',
  { timeout: 180000 }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
    const spaceId = await connectInSpace(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    const share = await A.request('share:create', { spaceId, name: 'Docs' })
    const folder = mkTmpDir(t)
    fs.writeFileSync(path.join(folder, 'keep.txt'), 'v1')
    fs.writeFileSync(path.join(folder, 'remove.txt'), 'doomed')
    const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
    await scanDone

    // B mirrors into a folder that ALREADY holds one of B's own files.
    await B.until('share:list', { spaceId }, (l) => l.some((s) => s.id === share.id))
    const mirrorDir = mkTmpDir(t)
    fs.writeFileSync(path.join(mirrorDir, 'my-own-notes.txt'), 'belongs to Bob, not the share')
    const active = B.waitFor('event:foreign-folder-mount-status',
      (m) => m.shareId === share.id && m.status === 'active', 90000)
    await B.request('foreign-folder:mount', { spaceId, shareId: share.id, ownerKey: aKey, mountPath: mirrorDir })
    await active
    await waitForFile(path.join(mirrorDir, 'keep.txt'), { present: true })
    await waitForFile(path.join(mirrorDir, 'remove.txt'), { present: true })

    // Owner edits keep.txt and deletes remove.txt (drive events the watcher
    // would normally raise; injected directly since there is no Electron main).
    fs.writeFileSync(path.join(folder, 'keep.txt'), 'v2-edited')
    await A.request('event:owned-folder-fs-event',
      { shareId: share.id, action: 'change', relPath: 'keep.txt', absPath: path.join(folder, 'keep.txt') })
    fs.rmSync(path.join(folder, 'remove.txt'))
    await A.request('event:owned-folder-fs-event',
      { shareId: share.id, action: 'unlink', relPath: 'remove.txt', absPath: path.join(folder, 'remove.txt') })

    // The mirror's poll tick (owner online, non-empty listing) honors both.
    await waitForFile(path.join(mirrorDir, 'remove.txt'), { present: false, ms: 120000 })
    t.is(fs.readFileSync(path.join(mirrorDir, 'keep.txt'), 'utf8'), 'v2-edited', 'edit propagated to mirror')
    t.absent(fs.existsSync(path.join(mirrorDir, 'remove.txt')), 'delete honored on the mirror (owner online)')
    // REGRESSION: the same honored-deletion tick must NOT remove the file Bob
    // already had in the folder — only files the mirror itself synced are
    // eligible for deletion.
    t.ok(fs.existsSync(path.join(mirrorDir, 'my-own-notes.txt')), "Bob's pre-existing file is left untouched")
  })

// MIR-07 through the real two-peer loop: B mirrors into a folder that already
// holds B's own file at a name the share ALSO uses. The share's version lands at
// a collision-free sibling, and an owner-side delete must remove only that
// sibling — never B's pre-existing file at the natural name. (An anchor file
// keeps the owner listing non-empty so the deletion gate honors the removal.)
test('REGRESSION (MIR-07): a peer delete removes only the mirror copy, never the user\'s conflicting file',
  { timeout: 180000 }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
    const spaceId = await connectInSpace(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    const share = await A.request('share:create', { spaceId, name: 'Docs' })
    const folder = mkTmpDir(t)
    fs.writeFileSync(path.join(folder, 'report.pdf'), 'OWNER-CONTENT')
    fs.writeFileSync(path.join(folder, 'anchor.txt'), 'stays')
    const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
    await scanDone

    // B mirrors into a folder that already holds its OWN report.pdf (a conflict).
    await B.until('share:list', { spaceId }, (l) => l.some((s) => s.id === share.id))
    const mirrorDir = mkTmpDir(t)
    fs.writeFileSync(path.join(mirrorDir, 'report.pdf'), 'BOB-OWN-REPORT')
    const active = B.waitFor('event:foreign-folder-mount-status',
      (m) => m.shareId === share.id && m.status === 'active', 90000)
    await B.request('foreign-folder:mount', { spaceId, shareId: share.id, ownerKey: aKey, mountPath: mirrorDir })
    await active

    // The share's version lands alongside; Bob's file is untouched.
    await waitForFile(path.join(mirrorDir, 'report (1).pdf'), { present: true })
    t.is(fs.readFileSync(path.join(mirrorDir, 'report (1).pdf'), 'utf8'), 'OWNER-CONTENT', 'share version at the collision-free sibling')
    t.is(fs.readFileSync(path.join(mirrorDir, 'report.pdf'), 'utf8'), 'BOB-OWN-REPORT', "Bob's file untouched after mount")

    // Owner deletes report.pdf from the share (anchor.txt remains → listing non-empty).
    fs.rmSync(path.join(folder, 'report.pdf'))
    await A.request('event:owned-folder-fs-event',
      { shareId: share.id, action: 'unlink', relPath: 'report.pdf', absPath: path.join(folder, 'report.pdf') })

    // The online reconcile removes only the mirror's sibling copy.
    await waitForFile(path.join(mirrorDir, 'report (1).pdf'), { present: false, ms: 120000 })
    t.is(fs.readFileSync(path.join(mirrorDir, 'report.pdf'), 'utf8'), 'BOB-OWN-REPORT', "Bob's conflicting file survives the peer delete")
    t.ok(fs.existsSync(path.join(mirrorDir, 'anchor.txt')), 'the anchor file is still mirrored')
  })
