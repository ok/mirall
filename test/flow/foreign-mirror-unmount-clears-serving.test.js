import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes, mkStoreDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

const FLAGS = { overlayEnabled: true }

// REGRESSION (FIX-MIRROR-STOP): end-to-end proof that a mirror paused mid-download and then
// unmounted while still online clears the OWNER's "who is downloading" indicator promptly. Before
// the fix the pause released the in-flight fetch slot, so the unmount signalled nothing and the
// owner kept showing the peer 'paused' until the 5-min PAUSED_DROP_MS sweep.
test('mirror paused then unmounted clears the owner serve ledger without waiting for the sweep',
  { timeout: scaled(120000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: mkStoreDir(t), flags: FLAGS })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', flags: FLAGS })
    const spaceId = await connectInSpace(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey
    const bKey = (await B.request('profile:get')).publicKey

    const share = await A.request('share:create', { spaceId, name: 'Vault', contentMode: 'overlay' })
    const folder = mkTmpDir(t)
    fs.writeFileSync(path.join(folder, 'big.bin'), patternedBytes(48 * 1024 * 1024, 29))
    const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
    await scanDone

    await B.until('share:list', { spaceId }, (list) => list.some((s) => s.id === share.id))

    const servesB = (rows) => Array.isArray(rows) && rows.some((r) => r.peers?.includes(bKey))
    const pausesB = (rows) => Array.isArray(rows) && rows.some((r) => r.pausedKeys?.includes(bKey))

    // The mount request returns before the initial scan finishes, so the fetch is still in flight.
    const mirrorDir = mkTmpDir(t)
    await B.request('foreign-folder:mount', { spaceId, shareId: share.id, ownerKey: aKey, mountPath: mirrorDir })

    // The owner sees B pulling the file — proves the fetch reached A and is in flight.
    await A.until('serving:summary-list', { spaceId }, servesB, { ms: 60000 })

    // B pauses mid-download → the owner's row flips to paused (CONTROL_PAUSED).
    await B.request('foreign-folder:set-enabled', { spaceId, shareId: share.id, enabled: false })
    await A.until('serving:summary-list', { spaceId }, pausesB, { ms: 30000 })

    // B unmounts while still online → notifyTransferStopped drops B from the owner's ledger now,
    // not after the 5-min sweep. Without the fix this poll times out.
    await B.request('foreign-folder:unmount', { spaceId, shareId: share.id })
    await A.until('serving:summary-list', { spaceId }, (rows) => !servesB(rows), { ms: 20000 })

    const finalRows = await A.request('serving:summary-list', { spaceId })
    t.absent(servesB(finalRows), 'owner no longer shows the unmounted mirror as downloading')

    A.kill()
  })
