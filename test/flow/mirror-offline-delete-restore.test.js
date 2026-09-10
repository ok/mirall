import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

// REGRESSION (FIX-MIRROR-OFFLINE): the offline gate skips the whole mirror tick, so a file the user
// deletes from the mirror directory while the owner is away is NOT restored until they return. The
// mirror fetches straight to the working file (never to a spool), so once it is deleted the bytes
// exist nowhere on this machine — the wait is a latency, not a loss. This pins both halves: nothing
// happens while the owner is away, and the restore is re-driven by their handshake rather than by a
// poll interval.
//
// Unlike mirror-offline-idle, the mirror is mounted and fully synced BEFORE the owner leaves: the
// file deleted must be one whose bytes this peer actually fetched.
test('a file deleted from the mirror while the owner is offline comes back when they return',
  { timeout: scaled(240000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const aStore = path.join(mkTmpDir(t), 'app-storage')
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
    const spaceId = await connectInSpace(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    const share = await A.request('share:create', { spaceId, name: 'Set' })
    const folder = mkTmpDir(t)
    const names = ['1.bin', '2.bin', '3.bin', '4.bin']
    const bytes = names.map((_, i) => patternedBytes(8 * 1024, i + 3))
    for (const [i, n] of names.entries()) fs.writeFileSync(path.join(folder, n), bytes[i])
    const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
    await scanDone

    const mirrorDir = mkTmpDir(t)
    await B.request('foreign-folder:mount', { spaceId, shareId: share.id, ownerKey: aKey, mountPath: mirrorDir })
    await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
      (f) => names.every((n) => f?.entries?.find((e) => e.relPath === n)?.status === 'synced'),
      { ms: 90000, every: 250 })
    const deleted = names[1]
    const deletedAbs = path.join(mirrorDir, deleted)
    t.ok(fs.readFileSync(deletedAbs).equals(bytes[1]), 'the file to delete was genuinely fetched')

    await A.request('shutdown').catch(() => {})
    await B.until('members:online', { spaceId }, (o) => !o.includes(aKey), { ms: 90000 })

    fs.unlinkSync(deletedAbs)

    // Longer than one 30s poll, so a tick is covered as well as any debounce, and sampled faster
    // than the overlay's 3s peer wait so a transient re-fetch cannot hide between samples.
    const deadline = Date.now() + scaled(35000)
    let recreated = false
    let sawDownloading = null
    while (Date.now() < deadline && !recreated && !sawDownloading) {
      recreated = fs.existsSync(deletedAbs)
      const listed = await B.request('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id })
      sawDownloading = listed?.entries?.find((e) => e.status === 'downloading')?.relPath ?? null
      await delay(300)
    }
    t.absent(recreated, 'the deleted file is not recreated while the owner is away — the bytes are not here')
    t.is(sawDownloading, null, 'and no row ever reported downloading')

    const offline = await B.request('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id })
    t.is(offline.entries.find((e) => e.relPath === deleted)?.status, 'unavailable', 'the deleted row reads unavailable')
    for (const n of names.filter((x) => x !== deleted)) {
      t.is(offline.entries.find((e) => e.relPath === n)?.status, 'synced', `${n} is untouched`)
    }
    const mount = await B.request('foreign-folder:get', { spaceId, shareId: share.id })
    t.is(mount.status, 'active', 'the mount is settled, not stuck mid-scan')
    t.ok(mount.syncedPaths.includes(deleted), 'the mirror has not forgotten the path it synced')

    // onOwnerOnline re-drives on the handshake, so the file must return well inside one 30s poll.
    // Measured: with the re-drive the restore lands within seconds of members:online; without it
    // the poll (or the owner's own rescan) brings it back roughly 24s later. The budget sits
    // between the two so a lost re-drive fails here rather than passing a poll late.
    await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore })
    await B.until('members:online', { spaceId }, (o) => o.includes(aKey), { ms: 90000 })
    await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
      (f) => f?.entries?.find((e) => e.relPath === deleted)?.status === 'synced',
      { ms: 10000, every: 250 })
    t.ok(fs.existsSync(deletedAbs), 'the file is back at its canonical path')
    t.ok(fs.readFileSync(deletedAbs).equals(bytes[1]), 'with its original bytes')
    t.alike(fs.readdirSync(mirrorDir).sort(), names, 'and nothing was moved aside')
  })
