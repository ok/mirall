import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// A peer LEAVES the space while a loose transfer is in flight. space:leave calls
// looseCancelSpace/overlayCancelSpace (worker/main.js) to tear down serving/fetching before
// the drive is purged; these prove that mid-transfer, over two real peers — untested until
// now (the audit's F2/F3 gaps). The failure mode this guards: a late completion re-writing a
// purged row, an orphaned partial-as-final, or a hung leave.
const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = () => ({ overlayEnabled: true, inPlaceFilesEnabled: true, identityKEK: kekHex() })
const sleep = (ms) => new Promise((r) => setTimeout(r, scaled(ms)))

async function startAndFlow (peer, spaceId, name, ownerKey) {
  const flowing = new Promise((resolve) => {
    peer.on('event:decoration', (m) => { if (m.channel === 'transfer' && m.spaceId === spaceId && m.key === '/' + name && m.bytes > 0) resolve() })
  })
  await peer.request('files:download', { spaceId, path: '/' + name, inPlace: true, ownerKey })
  await flowing
}
async function share (A, spaceId, dir, name, seed) {
  const bytes = patternedBytes(32 * 1024 * 1024, seed)
  fs.writeFileSync(path.join(dir, name), bytes)
  await A.request('files:add', { spaceId, filePath: path.join(dir, name), fileName: name, fileSize: bytes.length })
}
async function seeRemote (peer, spaceId, name) {
  await peer.until('files:list', { spaceId },
    (f) => Array.isArray(f) && f.some((e) => e.path === '/' + name && e.status === 'remote'), { ms: 60000 })
}

// F2 — the OWNER leaves the space while a peer is downloading.
test('owner leaves the space mid-serve: the peer does not complete, no orphan lands',
  { timeout: scaled(180000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const aSrc = mkTmpDir(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), flags: v2flags() })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const spaceId = await connectInSpaceWithApproval(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    await share(A, spaceId, aSrc, 'exit.bin', 43)
    await seeRemote(B, spaceId, 'exit.bin')
    let completed = false
    B.on('event:transfer-complete', (m) => { if (m.path === '/exit.bin') completed = true })
    await startAndFlow(B, spaceId, 'exit.bin', aKey)

    await A.request('space:leave', { spaceId }) // owner leaves mid-serve

    await sleep(8000)
    t.absent(completed, 'peer never completes after the owner leaves mid-serve')
    t.absent(fs.existsSync(path.join(B.downloads, 'exit.bin')), 'no orphan final file on the peer')
    const aSpaces = await A.request('spaces:list', {})
    t.absent(aSpaces.some((s) => s.spaceId === spaceId), 'owner has left the space')

    A.kill()
  })

// F3 — the DOWNLOADER leaves the space while its download is in flight.
test('downloader leaves the space mid-download: the transfer is purged, no orphan lands',
  { timeout: scaled(180000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const aSrc = mkTmpDir(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), flags: v2flags() })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const spaceId = await connectInSpaceWithApproval(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    await share(A, spaceId, aSrc, 'depart.bin', 47)
    await seeRemote(B, spaceId, 'depart.bin')
    let completed = false
    B.on('event:transfer-complete', (m) => { if (m.path === '/depart.bin') completed = true })
    await startAndFlow(B, spaceId, 'depart.bin', aKey)

    await B.request('space:leave', { spaceId }) // downloader leaves mid-download

    await sleep(8000)
    t.absent(completed, 'no late completion after the downloader leaves')
    t.absent(fs.existsSync(path.join(B.downloads, 'depart.bin')), 'no orphan final file left behind')
    const bSpaces = await B.request('spaces:list', {})
    t.absent(bSpaces.some((s) => s.spaceId === spaceId), 'downloader has left the space')

    A.kill()
  })
