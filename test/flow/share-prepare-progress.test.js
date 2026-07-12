import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

const FLAGS = { overlayEnabled: true, sharePrepareProgressEnabled: true }

// While the owner is still hashing a freshly-added file (advertised with contentHash:null),
// it broadcasts live indexing progress to connected members over the handshake channel. The
// receiver re-surfaces it as a preparing decoration so a waiting peer sees a determinate bar +
// ETA instead of a blank "Preparing…". The frame is ephemeral, so the receiver must be
// listening before the owner publishes.
test('owner broadcasts indexing progress; receiver sees a preparing decoration while the file is still hashing',
  { timeout: scaled(150000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: mkTmpDir(t), flags: FLAGS })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', downloads: mkTmpDir(t), flags: FLAGS })
    const spaceId = await connectInSpace(t, A, B)

    const share = await A.request('share:create', { spaceId, name: 'Vault', contentMode: 'overlay' })
    const decoKey = share.id + ':big.bin'

    const gotPrepare = B.waitFor('event:decoration',
      (m) => m.channel === 'transfer' && m.phase === 'preparing' && m.key === decoKey, 60000)

    const folder = mkTmpDir(t)
    fs.writeFileSync(path.join(folder, 'big.bin'), patternedBytes(4 * 1024 * 1024, 7))
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })

    const ev = await gotPrepare
    t.is(ev.key, decoKey, 'receiver got a preparing decoration for the file the owner is indexing')
    t.ok(typeof ev.total === 'number' && ev.total > 0, 'carries a total')
    t.ok(typeof ev.bytes === 'number' && ev.bytes >= 0 && ev.bytes <= ev.total, 'carries in-range bytes')
    t.ok(ev.eta === null || typeof ev.eta === 'number', 'carries an eta (null while still estimating)')
  })

// The broadcast is gated by the feature flag on the owner: with it off, no frame crosses the
// wire and a waiting peer falls back to the plain "Preparing…" → "remote" catalog transition.
test('owner with the flag off never broadcasts prepare-progress',
  { timeout: scaled(150000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: mkTmpDir(t), flags: { overlayEnabled: true, sharePrepareProgressEnabled: false } })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', downloads: mkTmpDir(t), flags: { overlayEnabled: true, sharePrepareProgressEnabled: true } })
    const spaceId = await connectInSpace(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    const share = await A.request('share:create', { spaceId, name: 'Vault', contentMode: 'overlay' })

    let prepareSeen = 0
    B.on('event:decoration', (m) => { if (m.channel === 'transfer' && m.phase === 'preparing' && typeof m.key === 'string' && m.key.startsWith(share.id + ':')) prepareSeen++ })

    const folder = mkTmpDir(t)
    fs.writeFileSync(path.join(folder, 'big.bin'), patternedBytes(4 * 1024 * 1024, 7))
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })

    // Wait until the file is fully published (catalog flips to remote) — by then any prepare
    // frames would have been sent. None should have, with the owner's flag off.
    await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
      (f) => Array.isArray(f?.entries) && f.entries.some((e) => e.relPath === 'big.bin' && e.status === 'remote'),
      { ms: 60000 })

    t.is(prepareSeen, 0, 'no prepare-progress reached the receiver while the owner flag was off')
  })
