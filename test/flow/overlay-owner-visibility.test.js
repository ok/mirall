import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes, mkStoreDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// The owner must refresh its file view incrementally during the scan, not just
// once at the end (which left it lagging the consumer for the whole hash-scan).
// New behaviour emits at least a leading (first advertise) + a terminal flush;
// the pre-fix code emitted exactly one refresh, at the end.
test('overlay owner refreshes incrementally during the scan, not only at the end',
  { timeout: scaled(150000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: mkStoreDir(t), flags: { overlayEnabled: true } })
    const aKey = (await A.request('profile:get')).publicKey
    const { spaceId } = await A.request('space:create', { name: 'Aurora' })
    const share = await A.request('share:create', { spaceId, name: 'Vault', contentMode: 'overlay' })

    const folder = mkTmpDir(t)
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(folder, `f${i}.bin`), patternedBytes(128 * 1024, i + 1))

    let scanCompleted = false
    let updatesDuringScan = 0
    A.on('event:share-files-updated', (m) => { if (m.shareId === share.id && !scanCompleted) updatesDuringScan++ })
    const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id, 120000)
    scanDone.then(() => { scanCompleted = true }).catch(() => {})

    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
    await scanDone

    t.ok(updatesDuringScan >= 2, `owner got ${updatesDuringScan} refreshes during the scan (pre-fix emitted exactly 1, at the end)`)

    const files = await A.request('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id })
    t.is(files.entries.length, 5, 'all files published')
    t.ok(files.entries.every((f) => f.hash), 'all files hashed (synced)')
  })
