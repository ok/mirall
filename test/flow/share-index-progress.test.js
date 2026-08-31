import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

const FLAGS = { overlayEnabled: true, sharePrepareProgressEnabled: true }

// A file that is only QUEUED has no catalog entry, so it replicates nothing — a member watching an
// owner add a folder saw only the two or three files being hashed at that instant. The owner now
// re-announces its queue depth over the handshake channel, the same ephemeral route the per-file
// hashing progress takes, so a member can see how much is still coming. Ephemeral by design: the
// receiver must be listening before the owner starts, and nothing is replayed.
test('owner broadcasts its scan queue; a member sees how much is still to be added',
  { timeout: scaled(150000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: mkTmpDir(t), flags: FLAGS })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', downloads: mkTmpDir(t), flags: FLAGS })
    const spaceId = await connectInSpace(t, A, B)

    const share = await A.request('share:create', { spaceId, name: 'Vault', contentMode: 'overlay' })

    // Armed before the mount: the frame is not replayed, so a late listener sees nothing.
    const gotQueue = B.waitFor('event:share-index-progress',
      (m) => m.spaceId === spaceId && m.shareId === share.id && m.adding > 1, 60000)
    const gotDrain = B.waitFor('event:share-index-progress',
      (m) => m.spaceId === spaceId && m.shareId === share.id && m.adding === 0, 90000)

    const folder = mkTmpDir(t)
    // Six, so the count is unambiguously more than the lane can hash at once — what a member
    // could not have learned from the catalog.
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(path.join(folder, `vol-0${i}.bin`), patternedBytes(2 * 1024 * 1024, 7 + i))
    }
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })

    const ev = await gotQueue
    t.ok(ev.adding > 1, 'the member is told about work no catalog entry exists for yet')
    t.ok(typeof ev.bytesQueued === 'number' && ev.bytesQueued >= 0, 'with the bytes still to read')

    await gotDrain
    t.pass('and is told when the queue is empty, so the notice cannot stick')
  })

// The broadcast rides the same flag as the per-file hashing progress: with it off nothing crosses
// the wire and a member simply learns about each file when its catalog entry replicates.
test('owner with the flag off never broadcasts its scan queue',
  { timeout: scaled(150000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: mkTmpDir(t), flags: { overlayEnabled: true, sharePrepareProgressEnabled: false } })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', downloads: mkTmpDir(t), flags: FLAGS })
    const spaceId = await connectInSpace(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    const share = await A.request('share:create', { spaceId, name: 'Vault', contentMode: 'overlay' })

    let seen = 0
    B.on('event:share-index-progress', (m) => { if (m.shareId === share.id) seen++ })

    const folder = mkTmpDir(t)
    fs.writeFileSync(path.join(folder, 'big.bin'), patternedBytes(4 * 1024 * 1024, 7))
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })

    // Drive to a deterministic terminal state — by the time the file is published, any frame would
    // long since have been sent. Never a sleep.
    await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
      (f) => Array.isArray(f?.entries) && f.entries.some((e) => e.relPath === 'big.bin' && e.status === 'remote'),
      { ms: 60000 })

    t.is(seen, 0, 'no scan-queue frame reached the member while the owner flag was off')
  })
