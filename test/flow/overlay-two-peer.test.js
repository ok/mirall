import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// Overlay: the owner's REAL file on disk is the source — nothing is copied into a
// drive. A peer lists from the replicated catalog and fetches by content hash
// straight from the owner over the hyper-overlay/v2 channel (serve-gated by
// membership). The headline proof: no drive blob import on the owner, ever.
const FLAGS = { overlayEnabled: true }

function spaceLive (info, spaceId) {
  const s = (info?.spaces || []).find((x) => x.spaceId === spaceId)
  return s ? s.contentBytes : 0
}

test('overlay: owner publishes in place (no second copy); peer fetches by content hash',
  { timeout: scaled(150000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: mkTmpDir(t), flags: FLAGS })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', downloads: mkTmpDir(t), flags: FLAGS })
    const spaceId = await connectInSpace(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    const share = await A.request('share:create', { spaceId, name: 'Vault', contentMode: 'overlay' })
    t.is(share.contentMode, 'overlay', 'share created in overlay mode under the flag')
    t.ok(share.catalogKey, 'share record carries the catalog key')

    const folder = mkTmpDir(t)
    const bytes = patternedBytes(256 * 1024, 9)
    fs.writeFileSync(path.join(folder, 'big.bin'), bytes)
    fs.writeFileSync(path.join(folder, 'two.bin'), patternedBytes(8 * 1024, 2))
    const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
    await scanDone

    // No second copy: overlay never imports bytes into a drive.
    const before = await A.request('storage:info')
    t.ok(spaceLive(before, spaceId) < bytes.length / 2, 'no drive import — serves in place')

    // B browses the catalog and waits until the file is `remote` (owner finished hashing).
    const listed = await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
      (f) => Array.isArray(f?.entries) && f.entries.some((e) => e.relPath === 'big.bin' && e.status === 'remote'),
      { ms: 60000 })
    const entry = listed.entries.find((e) => e.relPath === 'big.bin')
    t.is(entry.size, bytes.length, 'catalog carries the size')
    t.ok(entry.hash, 'catalog carries the content hash')

    // B fetches by content hash straight from the owner; bytes match. The download
    // is non-blocking (returns a transferId immediately), completion via event.
    const done = B.waitFor('event:transfer-complete', (m) => m.path === '/Vault/big.bin', 60000)
    const res = await B.request('share:read-file', { spaceId, ownerKey: aKey, shareId: share.id, relPath: 'big.bin' })
    t.ok(res?.transferId, 'overlay download returned a transferId (non-blocking)')
    const completed = await done
    t.ok(fs.readFileSync(completed.localPath).equals(bytes), 'downloaded bytes match the source')

    // Still no drive blobs on the owner — the fetch streamed from the source file.
    const after = await A.request('storage:info')
    t.ok(spaceLive(after, spaceId) < bytes.length / 2, 'still no drive materialization after serving')

    // B now lists the file as downloaded — and verified (the overlay checked the
    // whole-file hash byte-for-byte during the transfer).
    const post = await B.request('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id })
    const postRow = post.entries.find((e) => e.relPath === 'big.bin')
    t.is(postRow?.status, 'downloaded', 'file shows downloaded after fetch')
    t.is(postRow?.verified, true, 'downloaded file shows the verified badge (content hash matches)')
  })

test('overlay: a file is unavailable while the owner is offline',
  { timeout: scaled(150000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: mkTmpDir(t), flags: FLAGS })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', downloads: mkTmpDir(t), flags: FLAGS })
    const spaceId = await connectInSpace(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    const share = await A.request('share:create', { spaceId, name: 'Docs', contentMode: 'overlay' })
    const folder = mkTmpDir(t)
    fs.writeFileSync(path.join(folder, 'note.txt'), patternedBytes(16 * 1024, 3))
    const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
    await scanDone

    // Wait until B sees the hashed entry (remote) BEFORE the owner goes offline.
    await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
      (f) => Array.isArray(f?.entries) && f.entries.some((e) => e.relPath === 'note.txt' && e.status === 'remote'),
      { ms: 60000 })

    A.kill()
    await B.until('members:online', { spaceId }, (o) => !o.includes(aKey), { ms: 90000 })

    const files = await B.request('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id })
    t.is(files.entries.find((e) => e.relPath === 'note.txt')?.status, 'unavailable', 'file is unavailable with the owner offline')

    const res = await B.request('share:read-file', { spaceId, ownerKey: aKey, shareId: share.id, relPath: 'note.txt' })
    t.ok(res && res.queued, 'a download request queues (no holder online), no hang')
  })
