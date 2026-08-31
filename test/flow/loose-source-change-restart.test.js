import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// REGRESSION (FIX-1): an in-place (loose) file changes on the SENDER mid-download. The
// receiver must detect the new contentHash via the owner's catalog, abort the stale
// fetch, and auto-restart against the NEW content — surfacing event:transfer-superseded
// and finishing on the new bytes, WITHOUT a manual pause/resume and WITHOUT a misleading
// transfer-error. Before the fix the fetch stalled on the old hash (stale "Downloading"
// for ~30s, then PEER_NOT_AVAILABLE).
const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = () => ({ overlayEnabled: true, inPlaceFilesEnabled: true, identityKEK: kekHex() })
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')

test('loose download auto-restarts when the source changes mid-transfer',
  { timeout: scaled(180000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const aSrc = mkTmpDir(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const spaceId = await connectInSpaceWithApproval(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    // Large enough that B is comfortably mid-transfer when the source changes.
    // Large enough that B is still mid-transfer when A finishes re-hashing + advertising
    // the change (~1s) — so the restart path, not a lucky pre-completion, is exercised.
    // The explicit ordering guard below turns "window too small" into a clear assertion
    // failure rather than a flaky byte-mismatch, so this need not be huge (batch-safe).
    const original = patternedBytes(24 * 1024 * 1024, 47)
    const srcPath = path.join(aSrc, 'big.bin')
    fs.writeFileSync(srcPath, original)
    await A.request('files:add', { spaceId, filePath: srcPath, fileName: 'big.bin', fileSize: original.length })

    await B.until('files:list', { spaceId },
      (f) => Array.isArray(f) && f.some((e) => e.path === '/big.bin' && e.inPlace && e.status === 'remote'),
      { ms: 60000 })

    // Track ordering: a transfer-complete for /big.bin BEFORE the supersede means the
    // original finished first and the restart was never exercised (the test would then
    // be passing/failing for the wrong reason). Also fail loudly on any terminal error.
    let sawError = null
    let superseded = false
    let completedBeforeSupersede = false
    B.on('event:transfer-error', (m) => { if (m.path === '/big.bin') sawError = m.errorCode })
    B.on('event:transfer-superseded', (m) => { if (m.path === '/big.bin') superseded = true })
    B.on('event:transfer-complete', (m) => { if (m.path === '/big.bin' && !superseded) completedBeforeSupersede = true })

    // Start the download; wait until real bytes are flowing (genuinely mid-transfer).
    const flowing = new Promise((resolve) => {
      B.on('event:decoration', (m) => { if (m.channel === 'transfer' && m.spaceId === spaceId && m.key === '/big.bin' && m.bytes > 0) resolve() })
    })
    const supersededEvt = B.waitFor('event:transfer-superseded', (m) => m.path === '/big.bin', 120000)
    const done = B.waitFor('event:transfer-complete', (m) => m.path === '/big.bin' && superseded, 180000)
    await B.request('files:download', { spaceId, path: '/big.bin', inPlace: true, ownerKey: aKey })
    await flowing

    // Change the source on A (different size + content → new contentHash) and re-publish.
    const changed = patternedBytes(16 * 1024 * 1024, 99)
    fs.writeFileSync(srcPath, changed)
    await A.request('files:add', { spaceId, filePath: srcPath, fileName: 'big.bin', fileSize: changed.length })

    // Ordering assertion: the supersede must precede completion — proves the restart
    // path ran, not a race where the original completed and the change was never seen.
    const sup = await supersededEvt
    t.absent(completedBeforeSupersede, 'the original did not complete before the source-change was detected (restart path exercised)')
    t.is(sup.fileName, 'big.bin', 'transfer-superseded carries the file name for the notification')
    t.absent(sawError, 'no misleading transfer-error surfaced during the auto-restart')

    const completion = await done
    const landed = fs.readFileSync(completion.localPath)
    t.is(sha(landed), sha(changed), 'auto-restarted download landed the NEW content byte-exact')
    t.is(landed.length, changed.length, 'final size matches the changed source')
    t.absent(completion.localPath.endsWith('.mirall.part'), 'finalised, not a partial')
    t.absent(sawError, 'still no transfer-error after completion')

    A.kill()
  })
