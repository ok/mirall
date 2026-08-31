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

// REGRESSION (FIX-PREP2 + FIX-PREP5): the owner's own indexing row rode the CONSUMER's token
// ('preparing'), so the person adding the file was told the same thing as the person waiting on
// them — and the bar raised on that waiting member was never taken down, because the terminal
// `done` frame was emitted locally and never broadcast.
test('the owner indexes as publishing, the member as preparing, and the member gets a terminal frame',
  { timeout: scaled(180000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: mkTmpDir(t), flags: FLAGS })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', downloads: mkTmpDir(t), flags: FLAGS })
    const spaceId = await connectInSpace(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    const share = await A.request('share:create', { spaceId, name: 'Vault', contentMode: 'overlay' })
    const decoKey = share.id + ':huge.bin'
    const args = { spaceId, ownerKey: aKey, shareId: share.id }
    const rowOf = (f) => (Array.isArray(f?.entries) ? f.entries.find((e) => e.relPath === 'huge.bin') : null)

    const ownFrame = A.waitFor('event:decoration',
      (m) => m.channel === 'transfer' && m.key === decoKey && m.phase === 'publishing', 60000)
    const peerFrame = B.waitFor('event:decoration',
      (m) => m.channel === 'transfer' && m.key === decoKey && m.phase === 'preparing', 60000)
    const peerDone = B.waitFor('event:decoration',
      (m) => m.channel === 'transfer' && m.key === decoKey && m.done === true, 120000)

    // The reported case: a folder already mounted, files dropped INTO it. That publish is
    // interactive (direct catalog write), so the half-advertised row is visible the whole time it
    // hashes — which is exactly the window both sides were mislabelling.
    const folder = mkTmpDir(t)
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
    fs.writeFileSync(path.join(folder, 'huge.bin'), patternedBytes(256 * 1024 * 1024, 3))
    const published = A.request('event:owned-folder-fs-event',
      { shareId: share.id, action: 'add', relPath: 'huge.bin', absPath: path.join(folder, 'huge.bin') })
      .catch((err) => t.fail('fs event failed: ' + err.message))

    await A.until('share:list-files', args, (f) => rowOf(f)?.status === 'publishing', { ms: 60000 })
    t.pass("the owner's own row reads publishing while it hashes — it is adding the file, not fetching it")

    const own = await ownFrame
    t.is(own.phase, 'publishing', 'and its own bar is a publish bar, not a download one')
    const peer = await peerFrame
    t.is(peer.phase, 'preparing', 'the member watching gets the waiting side of the same hash')

    const done = await peerDone
    t.is(done.phase, 'preparing',
      'the terminal frame is phase-scoped — this key is shared with the member\'s own download of the same file')
    t.pass("the member's bar is taken down when the hash lands, instead of sitting at ~100% forever")

    await published
    await A.until('share:list-files', args, (f) => rowOf(f)?.status === 'synced', { ms: 60000 })
    await B.until('share:list-files', args, (f) => rowOf(f)?.status === 'remote', { ms: 60000 })
  })
