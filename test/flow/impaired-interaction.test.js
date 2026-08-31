import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'
import { LINKS } from '../helpers/impair.js'

// The failure-prone interaction paths (worst-case link + pause/resume churn) run under the
// adversarial shaper — the combinations most likely to expose a real timing bug. Both pass →
// the logic is robust even here; a timeout/failure = a reproduced field failure.
const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = (netImpair) => ({ overlayEnabled: true, inPlaceFilesEnabled: true, identityKEK: kekHex(), netImpair })
const sleep = (ms) => new Promise((r) => setTimeout(r, scaled(ms)))

async function seeRemote (B, spaceId, name) {
  await B.until('files:list', { spaceId }, (f) => Array.isArray(f) && f.some((e) => e.path === '/' + name && e.status === 'remote'), { ms: 120000 })
}
async function startAndFlow (B, spaceId, name, aKey) {
  const flowing = new Promise((resolve) => {
    B.on('event:decoration', (m) => { if (m.channel === 'transfer' && m.spaceId === spaceId && m.key === '/' + name && m.bytes > 0) resolve() })
  })
  await B.request('files:download', { spaceId, path: '/' + name, inPlace: true, ownerKey: aKey })
  await flowing
}

// Worst-case link on BOTH peers: high latency AND periodic drops.
test('a transfer completes over a brutal link (high latency + periodic drops on both peers)', { timeout: scaled(360000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const aSrc = mkTmpDir(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), flags: v2flags(LINKS.brutal) })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags(LINKS.brutal) })
  const spaceId = await connectInSpaceWithApproval(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey

  const bytes = patternedBytes(16 * 1024 * 1024, 91)
  fs.writeFileSync(path.join(aSrc, 'brutal.bin'), bytes)
  await A.request('files:add', { spaceId, filePath: path.join(aSrc, 'brutal.bin'), fileName: 'brutal.bin', fileSize: bytes.length })
  await seeRemote(B, spaceId, 'brutal.bin')

  const started = Date.now()
  const done = B.waitFor('event:transfer-complete', (m) => m.path === '/brutal.bin', 300000)
  await B.request('files:download', { spaceId, path: '/brutal.bin', inPlace: true, ownerKey: aKey })
  const completion = await done
  t.comment(`brutal.bin: 16 MB completed in ${Date.now() - started}ms on the brutal link`)
  t.ok(fs.readFileSync(completion.localPath).equals(bytes), 'byte-exact over the brutal link')
  A.kill()
})

// A manual pause must survive connection churn (a flaky downloader link repeatedly drops +
// reconnects while paused) without being auto-resumed, and a manual resume must still complete.
test('a manual pause and resume survive a flaky link (connection churn while paused)', { timeout: scaled(300000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const aSrc = mkTmpDir(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), flags: v2flags(LINKS.transcontinental) })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags(LINKS.flaky) })
  const spaceId = await connectInSpaceWithApproval(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey

  const bytes = patternedBytes(8 * 1024 * 1024, 93)
  fs.writeFileSync(path.join(aSrc, 'churn.bin'), bytes)
  await A.request('files:add', { spaceId, filePath: path.join(aSrc, 'churn.bin'), fileName: 'churn.bin', fileSize: bytes.length })
  await seeRemote(B, spaceId, 'churn.bin')

  await startAndFlow(B, spaceId, 'churn.bin', aKey)
  const transferId = (await B.request('files:list', { spaceId })).find((e) => e.path === '/churn.bin')?.transferId
  await B.request('files:pause-download', { transferId })
  await B.until('files:list', { spaceId }, (list) => { const e = list.find((x) => x.path === '/churn.bin'); return e && e.status === 'paused-interrupted' }, { ms: 60000 })

  // Let the flaky link drop + reconnect several times while paused.
  let autoResumed = false
  B.on('event:transfer-complete', (m) => { if (m.path === '/churn.bin') autoResumed = true })
  await sleep(24000) // ~2-3 flap cycles
  const row = (await B.request('files:list', { spaceId })).find((e) => e.path === '/churn.bin')
  t.ok(row && (row.status === 'paused-interrupted' || row.status === 'paused-offline'), `manual pause survives the churn (status=${row?.status})`)
  t.absent(autoResumed, 'reconnect churn did not spuriously auto-resume the manual pause')
  t.absent(fs.existsSync(path.join(B.downloads, 'churn.bin')), 'the paused file did not complete on its own')

  // A manual resume completes it despite the flaky link.
  const done = B.waitFor('event:transfer-complete', (m) => m.path === '/churn.bin', 180000)
  await B.request('files:download', { spaceId, path: '/churn.bin', inPlace: true, ownerKey: aKey })
  const completion = await done
  t.ok(fs.readFileSync(completion.localPath).equals(bytes), 'manual resume completes byte-exact over the flaky link')
  A.kill()
})
