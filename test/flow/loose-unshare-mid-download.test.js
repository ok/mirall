import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval, addApprovedPeer } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// Owner UNSHARES a loose file while peers are transferring (or have finished). The FE
// scenarios s88/s91/s97 exercise this UI-side; these prove the two-peer data-layer
// behaviour that fails in real multi-machine use. A deliberate unshare is terminal
// (FIX-REMOVE-1): a peer whose source is unshared mid-download tears the download down —
// discarding the partial and clearing the row — rather than settling to a resumable
// paused/interrupted state. These pin the invariants (no false completion, downloaded
// copies are kept) plus the terminal teardown.
const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = () => ({ overlayEnabled: true, inPlaceFilesEnabled: true, membershipApprovalEnabled: true, identityKEK: kekHex() })
const sleep = (ms) => new Promise((r) => setTimeout(r, scaled(ms)))

async function seeRemote (peer, spaceId, name) {
  await peer.until('files:list', { spaceId },
    (f) => Array.isArray(f) && f.some((e) => e.path === '/' + name && e.inPlace && e.status === 'remote'),
    { ms: 60000 })
}
// Start a loose download and resolve once real bytes are flowing (genuinely mid-transfer).
async function startAndFlow (peer, spaceId, name, ownerKey) {
  const flowing = new Promise((resolve) => {
    peer.on('event:decoration', (m) => { if (m.channel === 'transfer' && m.spaceId === spaceId && m.key === '/' + name && m.bytes > 0) resolve() })
  })
  await peer.request('files:download', { spaceId, path: '/' + name, inPlace: true, ownerKey })
  await flowing
}

// C1 — owner unshares a loose file while a single peer is mid-download.
test('loose unshare mid-download: the peer never falsely completes the removed content',
  { timeout: scaled(180000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const aSrc = mkTmpDir(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), flags: v2flags() })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const spaceId = await connectInSpaceWithApproval(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    const bytes = patternedBytes(32 * 1024 * 1024, 41)
    fs.writeFileSync(path.join(aSrc, 'big.bin'), bytes)
    await A.request('files:add', { spaceId, filePath: path.join(aSrc, 'big.bin'), fileName: 'big.bin', fileSize: bytes.length })
    await seeRemote(B, spaceId, 'big.bin')

    let completed = false
    let removed = false
    B.on('event:transfer-complete', (m) => { if (m.path === '/big.bin') completed = true })
    B.on('event:transfer-removed', (m) => { if (m.path === '/big.bin') removed = true })
    await startAndFlow(B, spaceId, 'big.bin', aKey)

    await A.request('files:remove', { spaceId, path: '/big.bin' }) // unshare mid-download

    await sleep(8000) // let the terminal teardown settle
    t.absent(completed, 'no transfer-complete fired for the removed content')
    t.ok(removed, 'the unshare terminated the download (event:transfer-removed)')
    t.absent(fs.existsSync(path.join(B.downloads, 'big.bin')), 'no full file landed on the peer')
    const row = (await B.request('files:list', { spaceId })).find((e) => e.path === '/big.bin')
    t.ok(row == null || row.status !== 'downloaded', 'peer row is not reported as downloaded')

    A.kill()
  })

// C5 — owner unshares a loose file the peer has ALREADY fully downloaded → the peer keeps it.
test('loose unshare after a completed download: the peer keeps its downloaded copy',
  { timeout: scaled(150000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const aSrc = mkTmpDir(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), flags: v2flags() })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const spaceId = await connectInSpaceWithApproval(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    const bytes = patternedBytes(4 * 1024 * 1024, 55)
    fs.writeFileSync(path.join(aSrc, 'keep.bin'), bytes)
    await A.request('files:add', { spaceId, filePath: path.join(aSrc, 'keep.bin'), fileName: 'keep.bin', fileSize: bytes.length })
    await seeRemote(B, spaceId, 'keep.bin')

    const done = B.waitFor('event:transfer-complete', (m) => m.path === '/keep.bin', 120000)
    await B.request('files:download', { spaceId, path: '/keep.bin', inPlace: true, ownerKey: aKey })
    const localPath = (await done).localPath
    t.ok(fs.existsSync(localPath), 'peer downloaded the file')

    await A.request('files:remove', { spaceId, path: '/keep.bin' }) // owner unshares it
    await sleep(8000)
    t.ok(fs.existsSync(localPath), 'peer keeps its downloaded copy on disk after the owner unshares')
    t.ok(fs.readFileSync(localPath).equals(bytes), 'the kept copy is byte-exact')

    A.kill()
  })

// F1 — two peers mid-download; the owner unshares → neither peer falsely completes.
test('loose unshare mid-download with two peers: neither peer falsely completes',
  { timeout: scaled(240000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const aSrc = mkTmpDir(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), flags: v2flags() })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const C = await launchPeer(t, { bootstrap, displayName: 'Carol', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const spaceId = await connectInSpaceWithApproval(t, A, B)
    await addApprovedPeer(A, C, spaceId)
    const aKey = (await A.request('profile:get')).publicKey

    const bytes = patternedBytes(32 * 1024 * 1024, 41)
    fs.writeFileSync(path.join(aSrc, 'group.bin'), bytes)
    await A.request('files:add', { spaceId, filePath: path.join(aSrc, 'group.bin'), fileName: 'group.bin', fileSize: bytes.length })
    await seeRemote(B, spaceId, 'group.bin')
    await seeRemote(C, spaceId, 'group.bin')

    let bDone = false; let cDone = false
    B.on('event:transfer-complete', (m) => { if (m.path === '/group.bin') bDone = true })
    C.on('event:transfer-complete', (m) => { if (m.path === '/group.bin') cDone = true })
    await startAndFlow(B, spaceId, 'group.bin', aKey)
    await startAndFlow(C, spaceId, 'group.bin', aKey)

    await A.request('files:remove', { spaceId, path: '/group.bin' }) // unshare with both mid-flight

    await sleep(8000)
    t.absent(bDone, 'Bob never completes the removed content')
    t.absent(cDone, 'Carol never completes the removed content')
    t.absent(fs.existsSync(path.join(B.downloads, 'group.bin')), 'nothing landed for Bob')
    t.absent(fs.existsSync(path.join(C.downloads, 'group.bin')), 'nothing landed for Carol')

    A.kill()
  })
