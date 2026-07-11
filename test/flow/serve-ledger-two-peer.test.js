import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval, addApprovedPeer } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// The OWNER's serve ledger (serving:summary-list) over two/three real peers — the sender-side
// "who is downloading" data that FE s73/s74/s75 render. Previously covered only with mocked
// data (unit/frontend) or single-peer (integration). Proves: a downloading peer appears in the
// summary, a paused peer surfaces in pausedKeys, a cancelling peer is dropped, and the entry
// clears once downloads finish.
const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = () => ({ overlayEnabled: true, inPlaceFilesEnabled: true, membershipApprovalEnabled: true, identityKEK: kekHex() })

async function shareAndSee (A, peers, spaceId, aSrc, name, seed, mb) {
  const bytes = patternedBytes(mb * 1024 * 1024, seed)
  fs.writeFileSync(path.join(aSrc, name), bytes)
  await A.request('files:add', { spaceId, filePath: path.join(aSrc, name), fileName: name, fileSize: bytes.length })
  for (const P of peers) {
    await P.until('files:list', { spaceId }, (f) => Array.isArray(f) && f.some((e) => e.path === '/' + name && e.status === 'remote'), { ms: 60000 })
  }
  return bytes
}
async function startAndFlow (peer, spaceId, name, ownerKey) {
  const flowing = new Promise((resolve) => {
    peer.on('event:decoration', (m) => { if (m.channel === 'transfer' && m.spaceId === spaceId && m.key === '/' + name && m.bytes > 0) resolve() })
  })
  await peer.request('files:download', { spaceId, path: '/' + name, inPlace: true, ownerKey })
  await flowing
}
const summaryFor = (list, p) => (Array.isArray(list) ? list.find((s) => s.path === p) : null)

// E1 — the ledger reflects a downloader, its pause, and clears on completion.
test('owner serve ledger: reflects a downloading peer, its pause, and clears on completion',
  { timeout: scaled(180000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const aSrc = mkTmpDir(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), flags: v2flags() })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const spaceId = await connectInSpaceWithApproval(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey
    const bKey = (await B.request('profile:get')).publicKey

    await shareAndSee(A, [B], spaceId, aSrc, 'feed.bin', 31, 16)
    await startAndFlow(B, spaceId, 'feed.bin', aKey)

    await A.until('serving:summary-list', { spaceId }, (list) => { const s = summaryFor(list, '/feed.bin'); return !!s && s.peers.includes(bKey) }, { ms: 30000 })
    t.pass('owner ledger shows the downloading peer')

    const transferId = (await B.request('files:list', { spaceId })).find((e) => e.path === '/feed.bin')?.transferId
    await B.request('files:pause-download', { transferId })
    await A.until('serving:summary-list', { spaceId }, (list) => { const s = summaryFor(list, '/feed.bin'); return !!s && s.pausedKeys.includes(bKey) }, { ms: 30000 })
    t.pass('owner ledger surfaces the peer as paused')

    const done = B.waitFor('event:transfer-complete', (m) => m.path === '/feed.bin', 120000)
    await B.request('files:download', { spaceId, path: '/feed.bin', inPlace: true, ownerKey: aKey }) // resume
    await done
    await A.until('serving:summary-list', { spaceId }, (list) => { const s = summaryFor(list, '/feed.bin'); return !s || !s.peers.includes(bKey) }, { ms: 45000 })
    t.pass('owner ledger clears the peer after completion')

    A.kill()
  })

// E2 — two peers download; one cancels → the ledger drops the canceller, the other completes.
test('owner serve ledger: two peers download, one cancels → the canceller is dropped, the other completes',
  { timeout: scaled(240000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const aSrc = mkTmpDir(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), flags: v2flags() })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const C = await launchPeer(t, { bootstrap, displayName: 'Carol', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const spaceId = await connectInSpaceWithApproval(t, A, B)
    await addApprovedPeer(A, C, spaceId)
    const aKey = (await A.request('profile:get')).publicKey
    const bKey = (await B.request('profile:get')).publicKey
    const cKey = (await C.request('profile:get')).publicKey

    await shareAndSee(A, [B, C], spaceId, aSrc, 'shared.bin', 37, 64)
    await startAndFlow(B, spaceId, 'shared.bin', aKey)
    await startAndFlow(C, spaceId, 'shared.bin', aKey)

    await A.until('serving:summary-list', { spaceId }, (list) => { const s = summaryFor(list, '/shared.bin'); return !!s && s.peers.includes(bKey) && s.peers.includes(cKey) }, { ms: 30000 })
    t.pass('owner ledger shows both downloaders')

    const cTransfer = (await C.request('files:list', { spaceId })).find((e) => e.path === '/shared.bin')?.transferId
    await C.request('files:cancel-download', { transferId: cTransfer })
    await A.until('serving:summary-list', { spaceId }, (list) => { const s = summaryFor(list, '/shared.bin'); return !s || !s.peers.includes(cKey) }, { ms: 45000 })
    t.pass('owner ledger dropped the canceller')

    const done = B.waitFor('event:transfer-complete', (m) => m.path === '/shared.bin', 180000)
    await done
    t.pass('the other peer completes its download')

    A.kill()
  })
