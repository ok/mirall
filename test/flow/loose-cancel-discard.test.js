import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// Loose CANCEL / DISCARD mechanics over two peers (FE s83/s84/s101). loose-pause-resume proves
// pause-and-keep; cancel-download and discard-partial (clear the partial) had NO two-peer flow
// coverage. A cancelled/discarded download returns the row to 'remote' with nothing left on
// disk, and re-downloading afterwards completes byte-exact (no stale partial).
const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = () => ({ overlayEnabled: true, inPlaceFilesEnabled: true, identityKEK: kekHex() })
const sleep = (ms) => new Promise((r) => setTimeout(r, scaled(ms)))

async function setup (t) {
  const bootstrap = await localTestnet(t)
  const aSrc = mkTmpDir(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), flags: v2flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const spaceId = await connectInSpaceWithApproval(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey
  return { A, B, spaceId, aKey, aSrc }
}
async function shareAndSee (A, B, spaceId, aSrc, name, seed) {
  const bytes = patternedBytes(8 * 1024 * 1024, seed)
  fs.writeFileSync(path.join(aSrc, name), bytes)
  await A.request('files:add', { spaceId, filePath: path.join(aSrc, name), fileName: name, fileSize: bytes.length })
  await B.until('files:list', { spaceId }, (f) => Array.isArray(f) && f.some((e) => e.path === '/' + name && e.status === 'remote'), { ms: 60000 })
  return bytes
}
async function startFlowGetTransfer (B, spaceId, name, aKey) {
  const flowing = new Promise((resolve) => {
    B.on('event:decoration', (m) => { if (m.channel === 'transfer' && m.spaceId === spaceId && m.key === '/' + name && m.bytes > 0) resolve() })
  })
  await B.request('files:download', { spaceId, path: '/' + name, inPlace: true, ownerKey: aKey })
  await flowing
  return (await B.request('files:list', { spaceId })).find((e) => e.path === '/' + name)?.transferId
}
const noResidue = (dir, stem) => !fs.readdirSync(dir).some((f) => f.includes(stem))

// A2 — cancel mid-download.
test('loose cancel mid-download: partial discarded, row back to remote, nothing on disk',
  { timeout: scaled(150000) }, async (t) => {
    const { A, B, spaceId, aKey, aSrc } = await setup(t)
    await shareAndSee(A, B, spaceId, aSrc, 'lump.bin', 13)
    const transferId = await startFlowGetTransfer(B, spaceId, 'lump.bin', aKey)
    t.ok(transferId, 'transferId derived')

    await B.request('files:cancel-download', { transferId })
    await B.until('files:list', { spaceId }, (list) => { const e = list.find((x) => x.path === '/lump.bin'); return e && e.status === 'remote' }, { ms: 30000 })
    await sleep(1000)
    t.ok(noResidue(B.downloads, 'lump'), 'no partial or final file left after cancel')
    A.kill()
  })

// A3 — pause then discard the partial.
test('loose pause then discard-partial: partial cleared, row back to remote',
  { timeout: scaled(150000) }, async (t) => {
    const { A, B, spaceId, aKey, aSrc } = await setup(t)
    await shareAndSee(A, B, spaceId, aSrc, 'draft.bin', 21)
    const transferId = await startFlowGetTransfer(B, spaceId, 'draft.bin', aKey)

    await B.request('files:pause-download', { transferId })
    await B.until('files:list', { spaceId }, (list) => { const e = list.find((x) => x.path === '/draft.bin'); return e && e.status === 'paused-interrupted' }, { ms: 30000 })
    await B.request('files:discard-partial', { spaceId, path: '/draft.bin' })
    await B.until('files:list', { spaceId }, (list) => { const e = list.find((x) => x.path === '/draft.bin'); return e && e.status === 'remote' }, { ms: 30000 })
    await sleep(1000)
    t.ok(noResidue(B.downloads, 'draft'), 'no partial left after discard')
    A.kill()
  })

// G2 — cancel then re-download → completes byte-exact.
test('loose cancel then re-download: completes byte-exact with no stale partial',
  { timeout: scaled(180000) }, async (t) => {
    const { A, B, spaceId, aKey, aSrc } = await setup(t)
    const bytes = await shareAndSee(A, B, spaceId, aSrc, 'retry.bin', 53)
    const transferId = await startFlowGetTransfer(B, spaceId, 'retry.bin', aKey)

    await B.request('files:cancel-download', { transferId })
    await B.until('files:list', { spaceId }, (list) => { const e = list.find((x) => x.path === '/retry.bin'); return e && e.status === 'remote' }, { ms: 30000 })

    const done = B.waitFor('event:transfer-complete', (m) => m.path === '/retry.bin', 120000)
    await B.request('files:download', { spaceId, path: '/retry.bin', inPlace: true, ownerKey: aKey })
    const completion = await done
    t.ok(fs.readFileSync(completion.localPath).equals(bytes), 're-downloaded file is byte-exact')
    t.ok(!completion.localPath.endsWith('.mirall.part'), 'finalised, not a partial')
    A.kill()
  })
