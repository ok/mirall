import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = () => ({ overlayEnabled: true, inPlaceFilesEnabled: true, identityKEK: kekHex() })

// FIX-EDA-20 (the paused toast blamed "sender offline" for a mid-download removal by an
// owner who stayed online) used owner-removal as the vehicle to produce an interrupted
// pause. FIX-REMOVE-1 makes a deliberate removal TERMINAL, so it no longer surfaces as a
// pause at all — it tears the download down. The interrupted-vs-offline pause-reason predicate
// FIX-EDA-20 protected now lives in test/unit/paused-status.test.js; here we pin the new
// terminal behavior: an online owner's mid-download removal terminates the transfer.
test('FIX-REMOVE-1: an online owner removing mid-download terminates the transfer, no lingering pause',
  { timeout: scaled(180000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const aSrc = mkTmpDir(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), flags: v2flags() })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const spaceId = await connectInSpaceWithApproval(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    const bytes = patternedBytes(32 * 1024 * 1024, 41)
    const srcPath = path.join(aSrc, 'big.bin')
    fs.writeFileSync(srcPath, bytes)
    await A.request('files:add', { spaceId, filePath: srcPath, fileName: 'big.bin', fileSize: bytes.length })

    await B.until('files:list', { spaceId },
      (f) => Array.isArray(f) && f.some((e) => e.path === '/big.bin' && e.inPlace && e.status === 'remote'),
      { ms: 60000 })

    const flowing = new Promise((resolve) => {
      B.on('event:decoration', (m) => { if (m.channel === 'transfer' && m.spaceId === spaceId && m.key === '/big.bin' && m.bytes > 0) resolve() })
    })
    // The removal is terminal → a 'removed' signal, NOT a lingering 'paused' event.
    const removed = B.waitFor('event:transfer-removed', (m) => m.path === '/big.bin', 120000)
    await B.request('files:download', { spaceId, path: '/big.bin', inPlace: true, ownerKey: aKey })
    await flowing

    await A.request('files:remove', { spaceId, path: '/big.bin' }) // owner stays online

    t.is((await removed).fileName, 'big.bin', 'the removal terminates the transfer (event:transfer-removed)')
    const row = (await B.request('files:list', { spaceId })).find((e) => e.path === '/big.bin')
    t.ok(row == null || (row.status !== 'paused-interrupted' && row.status !== 'downloaded'),
      'the download did not linger as a resumable paused-interrupted row')
    t.absent(fs.existsSync(path.join(B.downloads, 'big.bin')), 'no full file landed')

    A.kill()
  })
