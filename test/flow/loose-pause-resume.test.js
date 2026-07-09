import test from 'brittle'
import fs from 'fs'
import path from 'path'
import b4a from 'b4a'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// In-place (loose) downloads: real pause/resume (continue the partial, not restart)
// and auto-resume when the owner reconnects. The resume mechanics themselves are
// covered deterministically in the vendor tests (overlay-vendor-transfer +
// overlay-vendor-scheduler); these exercise the end-to-end wiring over two peers.
// Loose discovery rides the v2 membership fold (looseCatalogKey is folded from the
// owner's profile bee), so these run on v2 spaces (membership approval + identity
// store) — the model real installs use (membershipApproval defaults on).
const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = () => ({ overlayEnabled: true, inPlaceFilesEnabled: true, membershipApprovalEnabled: true, identityKEK: kekHex() })

test('loose download: pause mid-flight surfaces paused-interrupted; resume completes byte-exact',
  { timeout: scaled(180000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const spaceId = await connectInSpaceWithApproval(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    // Large enough to pause comfortably before the transfer finishes.
    const bytes = patternedBytes(8 * 1024 * 1024, 47)
    const srcPath = path.join(mkTmpDir(t), 'big.bin')
    fs.writeFileSync(srcPath, bytes)
    await A.request('files:add', { spaceId, filePath: srcPath, fileName: 'big.bin', fileSize: bytes.length })

    await B.until('files:list', { spaceId },
      (f) => Array.isArray(f) && f.some((e) => e.path === '/big.bin' && e.inPlace && e.status === 'remote'),
      { ms: scaled(60000) })

    // Capture the transferId from the first progress event; pause once real bytes flow.
    // REGRESSION (FIX-EDA-12): decoration frames carry spaceId — the bare drive path is
    // unique per space only, so the renderer scopes its decoration map by (spaceId, key).
    const flowing = new Promise((resolve) => {
      B.on('event:decoration', (m) => {
        if (m.channel === 'transfer' && m.spaceId === spaceId && m.key === '/big.bin' && m.bytes > 0) resolve()
      })
    })
    await B.request('files:download', { spaceId, path: '/big.bin', inPlace: true, ownerKey: aKey })
    await flowing

    // #6: a files:list during the active download reports 'downloading' (server-derived single
    // source of truth) — never paused-interrupted while the fetch is live. The transferId now
    // rides the row itself, so controls don't depend on a client-side transfer map.
    const midRow = (await B.request('files:list', { spaceId })).find((e) => e.path === '/big.bin')
    t.not(midRow?.status, 'paused-interrupted', 'active loose download is not reported as paused mid-flight')
    t.is(midRow?.status, 'downloading', 'active loose download is downloading')
    const transferId = midRow?.transferId
    t.ok(transferId, 'transferId derived on the row')

    await B.request('files:pause-download', { transferId })

    // Pause keeps the pending row → files:list surfaces paused-interrupted + pendingBytes.
    await B.until('files:list', { spaceId },
      (list) => {
        const e = Array.isArray(list) ? list.find((x) => x.path === '/big.bin') : null
        return e && e.status === 'paused-interrupted' && typeof e.pendingBytes === 'number' && e.pendingBytes > 0
      }, { ms: scaled(60000) })

    const paused = await B.request('files:list', { spaceId })
    const pausedRow = paused.find((e) => e.path === '/big.bin')
    t.is(pausedRow.status, 'paused-interrupted', 'row surfaced as paused-interrupted')
    t.ok(pausedRow.pendingBytes > 0, 'pendingBytes preserved through pause (partial kept)')

    // Resume = the same files:download IPC the Resume button triggers.
    const done = B.waitFor('event:transfer-complete', (m) => m.path === '/big.bin', scaled(120000))
    await B.request('files:download', { spaceId, path: '/big.bin', inPlace: true, ownerKey: aKey })
    const completion = await done

    const landed = fs.readFileSync(completion.localPath)
    const hash = (b) => crypto.createHash('sha256').update(b).digest('hex')
    t.is(hash(landed), hash(bytes), 'resumed download landed byte-exact')
    t.is(b4a.byteLength(landed), bytes.length, 'final size matches the source')
    t.ok(!completion.localPath.endsWith('.overlay-partial'), 'finalised, not a partial')

    A.kill()
  })

test('loose download auto-resumes when the owner returns (reconnect hook)',
  { timeout: scaled(180000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const aStore = idStore(t)
    const aSrc = mkTmpDir(t)
    const aFlags = v2flags() // stable identityKEK so the relaunch reloads the SAME identity
    let A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore, flags: aFlags })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const spaceId = await connectInSpaceWithApproval(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    const bytes = patternedBytes(64 * 1024, 9)
    const srcPath = path.join(aSrc, 'resume.bin')
    fs.writeFileSync(srcPath, bytes)
    await A.request('files:add', { spaceId, filePath: srcPath, fileName: 'resume.bin', fileSize: bytes.length })

    await B.until('files:list', { spaceId },
      (f) => Array.isArray(f) && f.some((e) => e.path === '/resume.bin' && e.inPlace && e.status === 'remote'),
      { ms: scaled(60000) })

    // Owner offline → the loose download queues (records a pending row carrying ownerKey).
    A.kill()
    await B.until('members:online', { spaceId }, (o) => !o.includes(aKey), { ms: scaled(90000) })
    const queued = await B.request('files:download', { spaceId, path: '/resume.bin', inPlace: true, ownerKey: aKey })
    t.ok(queued && queued.queued, 'loose download queued while owner offline')

    // Owner returns with the SAME storage (source still servable). On A's handshake,
    // B's reconnect hook (resumeLooseForOwner) re-triggers the download with NO manual click.
    const done = B.waitFor('event:transfer-complete', (m) => m.path === '/resume.bin', scaled(120000))
    A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore, flags: aFlags })
    const completed = await done

    t.ok(!completed.localPath.endsWith('.overlay-partial'), 'finalised, not a partial')
    t.ok(fs.readFileSync(completed.localPath).equals(bytes), 'auto-resumed loose download bytes match source')

    A.kill()
  })

test('REGRESSION (FIX-EDA-2: a manual pause survives an owner catalog re-append — no auto-resume)',
  { timeout: scaled(180000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const spaceId = await connectInSpaceWithApproval(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    const bytes = patternedBytes(8 * 1024 * 1024, 51)
    const srcPath = path.join(mkTmpDir(t), 'big.bin')
    fs.writeFileSync(srcPath, bytes)
    await A.request('files:add', { spaceId, filePath: srcPath, fileName: 'big.bin', fileSize: bytes.length })
    await B.until('files:list', { spaceId },
      (f) => Array.isArray(f) && f.some((e) => e.path === '/big.bin' && e.inPlace && e.status === 'remote'),
      { ms: scaled(60000) })

    const flowing = new Promise((resolve) => {
      B.on('event:decoration', (m) => { if (m.channel === 'transfer' && m.spaceId === spaceId && m.key === '/big.bin' && m.bytes > 0) resolve() })
    })
    await B.request('files:download', { spaceId, path: '/big.bin', inPlace: true, ownerKey: aKey })
    await flowing
    const transferId = (await B.request('files:list', { spaceId })).find((e) => e.path === '/big.bin')?.transferId
    await B.request('files:pause-download', { transferId })
    await B.until('files:list', { spaceId },
      (list) => { const e = Array.isArray(list) ? list.find((x) => x.path === '/big.bin') : null; return !!e && e.status === 'paused-interrupted' },
      { ms: scaled(60000) })

    // Owner appends an UNRELATED file → B's peer-catalog watch fires resumeForOwner. A MANUAL pause
    // must NOT be resurrected by that (the bug: catalog re-append restarts user-paused downloads).
    let bigResumed = false
    B.on('event:transfer-complete', (m) => { if (m.path === '/big.bin') bigResumed = true })
    B.on('event:decoration', (m) => { if (m.channel === 'transfer' && m.key === '/big.bin') bigResumed = true })
    const smallPath = path.join(mkTmpDir(t), 'small.txt')
    fs.writeFileSync(smallPath, 'unrelated')
    await A.request('files:add', { spaceId, filePath: smallPath, fileName: 'small.txt', fileSize: 9 })
    await B.until('files:list', { spaceId },
      (f) => Array.isArray(f) && f.some((e) => e.path === '/small.txt'),
      { ms: scaled(60000) })
    // Give resumeForOwner ample time to (wrongly) restart, then assert it did not.
    await new Promise((r) => setTimeout(r, scaled(6000)))
    const row = (await B.request('files:list', { spaceId })).find((e) => e.path === '/big.bin')
    t.is(row?.status, 'paused-interrupted', 'paused download stays paused after an owner catalog re-append')
    t.absent(bigResumed, 'no auto-resume (no progress/complete) for the manually-paused file')

    A.kill()
  })
