import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

// REGRESSION (FIX-MIRROR-OFFLINE): with the owner offline the mirror walked its whole catalog and
// issued a fetch per file, each burning the overlay's 3s peer wait for a no-holder that was certain
// in advance. The pass outran its own 30s interval, so it re-fired immediately and never idled, and
// each in-flight file reported 'downloading' — which the renderer paints as a rotating "Preparing…"
// badge directly beneath its own "the owner is offline" banner.
//
// The mount is created AFTER the owner quits, which is the reported shape (14 files, 0 on device)
// and the only one that actually reproduces. Mirroring first and then deleting the files does NOT:
// a completed fetch registers the blob in our own overlay spool, so fetchFile answers the re-fetch
// from local disk with no peer at all, and the mirror converges instead of spinning. B never holds
// this content, so every fetch it attempts must go to a holder that is not there.
//
// It also covers the path with no tick gate above it: the initial mount scan.
test('a mirror mounted against an offline owner stays quiet, and syncs when they return',
  { timeout: scaled(240000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const aStore = path.join(mkTmpDir(t), 'app-storage')
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
    const spaceId = await connectInSpace(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    // Several files, so a spin has something to rotate THROUGH — one file could cycle unnoticed.
    const share = await A.request('share:create', { spaceId, name: 'Set' })
    const folder = mkTmpDir(t)
    const names = ['1.bin', '2.bin', '3.bin', '4.bin']
    for (const [i, n] of names.entries()) fs.writeFileSync(path.join(folder, n), patternedBytes(8 * 1024, i + 3))
    const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
    await scanDone

    // Read the listing while the owner is still up: that is what replicates the catalog blocks B
    // needs to render rows at all once A is gone. Without it a quiet mirror would prove nothing —
    // it would be quiet because it had no catalog to walk.
    await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
      (f) => names.every((n) => f?.entries?.some((e) => e.relPath === n)), { ms: 60000, every: 250 })

    // The owner quits gracefully — the {type:'shutdown'} the Electron main sends.
    await A.request('shutdown').catch(() => {})
    await B.until('members:online', { spaceId }, (o) => !o.includes(aKey), { ms: 90000 })

    const mirrorDir = mkTmpDir(t)
    await B.request('foreign-folder:mount', { spaceId, shareId: share.id, ownerKey: aKey, mountPath: mirrorDir })

    // Sample faster than the 3s peer wait so a single spinning file cannot hide between samples,
    // and for longer than one 30s poll so a tick is covered as well as the initial scan.
    const deadline = Date.now() + scaled(40000)
    let sawDownloading = null
    while (Date.now() < deadline && !sawDownloading) {
      const listed = await B.request('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id })
      sawDownloading = listed?.entries?.find((e) => e.status === 'downloading')?.relPath ?? null
      await delay(300)
    }
    t.is(sawDownloading, null, 'no row ever reported downloading while the owner was offline')

    const offline = await B.request('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id })
    t.is(offline.entries.length, names.length, 'the rows render from the replicated catalog')
    t.ok(offline.entries.every((e) => e.status === 'unavailable'),
      'every row reads unavailable, matching the offline banner above it')
    t.absent(fs.readdirSync(mirrorDir).length, 'and nothing was written — there was nothing to fetch from')

    // Quiet is not the same as unfinished: the initial scan still has to settle the mount, or a
    // folder mounted during an outage sits on "Scanning" until the owner comes back.
    const mount = await B.request('foreign-folder:get', { spaceId, shareId: share.id })
    t.is(mount.status, 'active', 'the mount settled rather than sticking mid-scan')

    // Quiet must not mean STUCK: onOwnerOnline re-drives on the handshake, so the files arrive
    // without waiting out a poll interval.
    await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore })
    await B.until('members:online', { spaceId }, (o) => o.includes(aKey), { ms: 90000 })
    await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
      (f) => names.every((n) => f?.entries?.find((e) => e.relPath === n)?.status === 'synced'),
      { ms: 60000, every: 250 })
    for (const n of names) t.ok(fs.existsSync(path.join(mirrorDir, n)), `${n} materialized once the owner returned`)
  })
