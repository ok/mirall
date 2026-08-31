import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes, mkStoreDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

const FLAGS = { overlayEnabled: true }

// REGRESSION (FIX-EDA-7: overlayConsumerRow's foreignMount branch early-returned 'remote'
// before any active-fetch check, and mirror fetches run in the foreign loop — never in the
// folder engine — so a materializing mirror row showed no progress UI for the whole
// download, then jumped straight to synced).
test('REGRESSION (FIX-EDA-7): a materializing mirror row reports downloading, then synced',
  { timeout: scaled(240000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: mkStoreDir(t), flags: FLAGS })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', downloads: mkTmpDir(t), flags: FLAGS })
    const spaceId = await connectInSpace(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    const share = await A.request('share:create', { spaceId, name: 'Vault', contentMode: 'overlay' })
    const folder = mkTmpDir(t)
    // Large enough that the mirror fetch spans several list polls on the local testnet.
    const bytes = patternedBytes(96 * 1024 * 1024, 19)
    fs.writeFileSync(path.join(folder, 'big.bin'), bytes)
    const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
    await scanDone

    await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
      (f) => Array.isArray(f?.entries) && f.entries.some((e) => e.relPath === 'big.bin' && e.status === 'remote'),
      { ms: 60000 })

    // Arm the downloading observation BEFORE the mount so no window is missed.
    const sawDownloading = B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
      (f) => Array.isArray(f?.entries) && f.entries.some((e) => e.relPath === 'big.bin' && e.status === 'downloading'),
      { ms: 120000 })

    const mirrorDir = mkTmpDir(t)
    await B.request('foreign-folder:mount', { spaceId, shareId: share.id, ownerKey: aKey, mountPath: mirrorDir })
    await sawDownloading
    t.pass('mirror row surfaced downloading while the foreign loop materialized it')

    await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
      (f) => Array.isArray(f?.entries) && f.entries.some((e) => e.relPath === 'big.bin' && e.status === 'synced'),
      { ms: 180000 })
    t.ok(fs.readFileSync(path.join(mirrorDir, 'big.bin')).equals(bytes), 'mirror landed byte-exact')

    A.kill()
  })
