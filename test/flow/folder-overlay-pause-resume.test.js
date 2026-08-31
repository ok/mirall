import test from 'brittle'
import fs from 'fs'
import path from 'path'
import b4a from 'b4a'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes, mkStoreDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// Non-mirrored overlay folder downloads now run on the same engine as space-root
// loose files, so they gain real pause/resume + auto-resume on owner reconnect
// (previously fire-and-forget; the pause/stop buttons were no-ops). End-to-end proof.
const FLAGS = { overlayEnabled: true }

test('overlay folder: pause mid-flight surfaces paused-interrupted; resume completes byte-exact',
  { timeout: scaled(180000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: mkStoreDir(t), flags: FLAGS })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', downloads: mkTmpDir(t), flags: FLAGS })
    const spaceId = await connectInSpace(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    const share = await A.request('share:create', { spaceId, name: 'Vault', contentMode: 'overlay' })
    const folder = mkTmpDir(t)
    const bytes = patternedBytes(8 * 1024 * 1024, 31)
    fs.writeFileSync(path.join(folder, 'big.bin'), bytes)
    const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
    await scanDone

    await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
      (f) => Array.isArray(f?.entries) && f.entries.some((e) => e.relPath === 'big.bin' && e.status === 'remote'),
      { ms: 60000 })

    const flowing = new Promise((resolve) => {
      B.on('event:decoration', (m) => {
        if (m.channel !== 'transfer' || m.key !== share.id + ':big.bin' || m.done) return
        if (m.bytes > 0) resolve()
      })
    })
    const started = await B.request('share:read-file', { spaceId, ownerKey: aKey, shareId: share.id, relPath: 'big.bin' })
    const transferId = started?.transferId
    await flowing
    t.ok(transferId, 'transferId from the share:read-file response')

    await B.request('files:pause-download', { transferId })

    await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
      (list) => {
        const e = Array.isArray(list?.entries) ? list.entries.find((x) => x.relPath === 'big.bin') : null
        return e && e.status === 'paused-interrupted' && typeof e.pendingBytes === 'number' && e.pendingBytes > 0
      }, { ms: 60000 })

    const paused = await B.request('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id })
    const pausedRow = paused.entries.find((e) => e.relPath === 'big.bin')
    t.is(pausedRow.status, 'paused-interrupted', 'overlay folder file surfaced as paused-interrupted')
    t.ok(pausedRow.pendingBytes > 0, 'pendingBytes preserved through pause (partial kept)')

    // Resume = the same share:read-file IPC the Resume button triggers.
    const done = B.waitFor('event:transfer-complete', (m) => m.path === '/Vault/big.bin', 120000)
    await B.request('share:read-file', { spaceId, ownerKey: aKey, shareId: share.id, relPath: 'big.bin' })
    const completion = await done

    const landed = fs.readFileSync(completion.localPath)
    const hash = (b) => crypto.createHash('sha256').update(b).digest('hex')
    t.is(hash(landed), hash(bytes), 'resumed overlay folder download landed byte-exact')
    t.is(b4a.byteLength(landed), bytes.length, 'final size matches the source')

    A.kill()
  })

test('overlay folder: a queued download auto-resumes when the owner returns',
  { timeout: scaled(180000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const aStore = mkStoreDir(t)
    const folder = mkTmpDir(t)
    let A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore, flags: FLAGS })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', downloads: mkTmpDir(t), flags: FLAGS })
    const spaceId = await connectInSpace(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    const share = await A.request('share:create', { spaceId, name: 'Docs', contentMode: 'overlay' })
    const bytes = patternedBytes(64 * 1024, 12)
    fs.writeFileSync(path.join(folder, 'resume.bin'), bytes)
    const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
    await scanDone

    await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
      (f) => Array.isArray(f?.entries) && f.entries.some((e) => e.relPath === 'resume.bin' && e.status === 'remote'),
      { ms: 60000 })

    A.kill()
    await B.until('members:online', { spaceId }, (o) => !o.includes(aKey), { ms: 90000 })
    const queued = await B.request('share:read-file', { spaceId, ownerKey: aKey, shareId: share.id, relPath: 'resume.bin' })
    t.ok(queued && queued.queued, 'overlay folder download queued while owner offline')

    const done = B.waitFor('event:transfer-complete', (m) => m.path === '/Docs/resume.bin', 120000)
    A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore, flags: FLAGS })
    const completed = await done

    t.ok(!completed.localPath.endsWith('.mirall.part'), 'finalised, not a partial')
    t.ok(fs.readFileSync(completed.localPath).equals(bytes), 'auto-resumed overlay folder download bytes match source')

    A.kill()
  })

// REGRESSION (FIX-EDA-15: the folder twin of FIX-EDA-2 — the peer-catalog append watch now
// triggers resumeForOwner on the folder channel too, and a MANUAL pause must survive it.
// The positive auto-resume path is covered by the owner-returns test above.)
test('REGRESSION (FIX-EDA-15: a manual folder pause survives an owner catalog append — no auto-resume)',
  { timeout: scaled(240000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: mkStoreDir(t), flags: FLAGS })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', downloads: mkTmpDir(t), flags: FLAGS })
    const spaceId = await connectInSpace(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    const share = await A.request('share:create', { spaceId, name: 'Vault', contentMode: 'overlay' })
    const folder = mkTmpDir(t)
    const bytes = patternedBytes(8 * 1024 * 1024, 37)
    fs.writeFileSync(path.join(folder, 'big.bin'), bytes)
    const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
    await scanDone

    await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
      (f) => Array.isArray(f?.entries) && f.entries.some((e) => e.relPath === 'big.bin' && e.status === 'remote'),
      { ms: 60000 })

    const flowing = new Promise((resolve) => {
      B.on('event:decoration', (m) => {
        if (m.channel !== 'transfer' || m.key !== share.id + ':big.bin' || m.done) return
        if (m.bytes > 0) resolve()
      })
    })
    const started = await B.request('share:read-file', { spaceId, ownerKey: aKey, shareId: share.id, relPath: 'big.bin' })
    const transferId = started?.transferId
    await flowing
    await B.request('files:pause-download', { transferId })
    await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
      (list) => {
        const e = Array.isArray(list?.entries) ? list.entries.find((x) => x.relPath === 'big.bin') : null
        return !!e && e.status === 'paused-interrupted'
      }, { ms: 60000 })

    // Owner appends an UNRELATED file → B's peer-catalog watch fires resumeForOwner on the
    // folder channel. A MANUAL pause must not be resurrected — and (FIX-EDA-14) the gated row
    // must not even be job-built.
    let bigResumed = false
    B.on('event:decoration', (m) => { if (m.channel === 'transfer' && m.key === share.id + ':big.bin' && !m.done) bigResumed = true })
    B.on('event:transfer-complete', (m) => { if (m.path === '/Vault/big.bin') bigResumed = true })
    fs.writeFileSync(path.join(folder, 'small.txt'), 'unrelated')
    await A.request('event:owned-folder-fs-event',
      { shareId: share.id, action: 'add', relPath: 'small.txt', absPath: path.join(folder, 'small.txt') })
    await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
      (f) => Array.isArray(f?.entries) && f.entries.some((e) => e.relPath === 'small.txt'),
      { ms: 60000 })

    // Give resumeForOwner ample time to (wrongly) restart, then assert it did not.
    await new Promise((r) => setTimeout(r, scaled(6000)))
    const row = (await B.request('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id })).entries.find((e) => e.relPath === 'big.bin')
    t.is(row?.status, 'paused-interrupted', 'paused folder download stays paused after an owner catalog append')
    t.absent(bigResumed, 'no auto-resume (no progress/complete) for the manually-paused file')

    A.kill()
  })
