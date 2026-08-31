import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// REGRESSION (FIX-1: the only seeder quits MID-download. The downloader must surface the
// file as owner-offline (resumable) — NOT 'error'/'Transfer failed' — and auto-resume to
// completion when the seeder returns. The overlay give-up used to record a hard errorCode
// (PEER_NOT_AVAILABLE) → status 'error'; it must leave a clean pending row → paused-offline.
// Loose (in-place) path; folder shares ride the same engine + derivation.
const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = (over = {}) => ({ overlayEnabled: true, inPlaceFilesEnabled: true, identityKEK: kekHex(), ...over })

test('seeder quitting mid-download surfaces paused-offline, then auto-resumes',
  { timeout: scaled(180000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const aStore = idStore(t)
    const aSrc = mkTmpDir(t)
    const aFlags = v2flags() // stable identityKEK so the relaunch reloads the SAME identity + drive
    let A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore, flags: aFlags })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const spaceId = await connectInSpaceWithApproval(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    // Big enough that B is still mid-transfer when A quits (chunks remain outstanding).
    const bytes = patternedBytes(8 * 1024 * 1024, 53)
    const srcPath = path.join(aSrc, 'big.bin')
    fs.writeFileSync(srcPath, bytes)
    await A.request('files:add', { spaceId, filePath: srcPath, fileName: 'big.bin', fileSize: bytes.length })

    await B.until('files:list', { spaceId },
      (f) => Array.isArray(f) && f.some((e) => e.path === '/big.bin' && e.inPlace && e.status === 'remote'),
      { ms: 60000 })

    // Start the download; resolve once real bytes are flowing (genuinely mid-transfer).
    const flowing = new Promise((resolve) => {
      B.on('event:decoration', (m) => { if (m.channel === 'transfer' && m.spaceId === spaceId && m.key === '/big.bin' && m.bytes > 0) resolve() })
    })
    await B.request('files:download', { spaceId, path: '/big.bin', inPlace: true, ownerKey: aKey })
    await flowing

    // A quits — the only seeder goes away mid-download.
    A.kill()
    await B.until('members:online', { spaceId }, (o) => !o.includes(aKey), { ms: 90000 })

    // THE REGRESSION ASSERTION: the row settles at paused-offline, never 'error'. On the
    // bug this poll never resolves (status is stuck 'error') → red.
    const settled = await B.until('files:list', { spaceId },
      (l) => Array.isArray(l) && l.find((e) => e.path === '/big.bin')?.status === 'paused-offline',
      { ms: 90000 })
    const row = settled.find((e) => e.path === '/big.bin')
    t.is(row.status, 'paused-offline', 'owner-offline state, not a failure')
    t.absent(row.errorCode, 'no errorCode recorded for a quit seeder')

    // A returns with the SAME storage (source still servable) → auto-resume, no manual click.
    const done = B.waitFor('event:transfer-complete', (m) => m.path === '/big.bin', 120000)
    A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore, flags: aFlags })
    const completed = await done

    t.ok(!completed.localPath.endsWith('.mirall.part'), 'finalised, not a partial')
    t.ok(fs.readFileSync(completed.localPath).equals(bytes), 'resumed download bytes match source')

    A.kill()
  })
