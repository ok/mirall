import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace, addPeerToSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

const FLAGS = { overlayEnabled: true }

// GAP #10: two peers download the SAME file from one owner at the same time. The owner
// must serve concurrent reads of one blob, and each downloader must finalise its own
// `.overlay-partial` to byte-exact content without a bookkeeping race / partial collision.
// Overlay is now the sole serving path, so this is the only guard for concurrent serving.
test('REGRESSION (GAP #10): concurrent downloaders of one file each land byte-exact',
  { timeout: scaled(150000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: mkTmpDir(t), flags: FLAGS })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', downloads: mkTmpDir(t), flags: FLAGS })
    const C = await launchPeer(t, { bootstrap, displayName: 'Carol', downloads: mkTmpDir(t), flags: FLAGS })
    const spaceId = await connectInSpace(t, A, B)
    await addPeerToSpace(A, C, spaceId)
    const aKey = (await A.request('profile:get')).publicKey

    const share = await A.request('share:create', { spaceId, name: 'Vault' })
    const folder = mkTmpDir(t)
    const bytes = patternedBytes(256 * 1024, 9)
    fs.writeFileSync(path.join(folder, 'big.bin'), bytes)
    const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
    await scanDone

    // Both peers wait until they see the file as `remote` (owner finished hashing).
    const seeRemote = (P) => P.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
      (f) => Array.isArray(f?.entries) && f.entries.some((e) => e.relPath === 'big.bin' && e.status === 'remote'),
      { ms: 60000 })
    await Promise.all([seeRemote(B), seeRemote(C)])

    // Fire both downloads at the same time — the owner serves both concurrently.
    const doneB = B.waitFor('event:transfer-complete', (m) => m.path === '/Vault/big.bin', 90000)
    const doneC = C.waitFor('event:transfer-complete', (m) => m.path === '/Vault/big.bin', 90000)
    const [resB, resC] = await Promise.all([
      B.request('share:read-file', { spaceId, ownerKey: aKey, shareId: share.id, relPath: 'big.bin' }),
      C.request('share:read-file', { spaceId, ownerKey: aKey, shareId: share.id, relPath: 'big.bin' }),
    ])
    t.ok(resB?.transferId && resC?.transferId, 'both downloads started (non-blocking)')

    const [compB, compC] = await Promise.all([doneB, doneC])
    t.ok(fs.readFileSync(compB.localPath).equals(bytes), 'B landed byte-exact')
    t.ok(fs.readFileSync(compC.localPath).equals(bytes), 'C landed byte-exact')
    t.not(compB.localPath, compC.localPath, 'each downloader finalised its own file')
  })
