import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'
import { LINKS } from '../helpers/impair.js'

// Adversarial-network flow tests: the SAME two-peer interactions, but each peer's swarm
// connections are shaped (latency / jitter / flap) via the runtime-config `netImpair` knob to
// reproduce the bad real-world links that hermetic-testnet tests can't (they're lossless, local,
// low-RTT). The hermetic suite proves the logic is correct; these prove it holds up — or expose
// where it doesn't — under a degraded link. Generous timeouts: a pass = robust; a timeout =
// a reproduced field failure (convergence/resume stalls on a real link).
const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = (netImpair) => ({ overlayEnabled: true, inPlaceFilesEnabled: true, membershipApprovalEnabled: true, identityKEK: kekHex(), netImpair })

async function shareSeeDownload (t, A, B, spaceId, aKey, aSrc, name, mb, seed) {
  const bytes = patternedBytes(mb * 1024 * 1024, seed)
  fs.writeFileSync(path.join(aSrc, name), bytes)
  await A.request('files:add', { spaceId, filePath: path.join(aSrc, name), fileName: name, fileSize: bytes.length })
  await B.until('files:list', { spaceId }, (f) => Array.isArray(f) && f.some((e) => e.path === '/' + name && e.status === 'remote'), { ms: scaled(120000) })
  const started = Date.now()
  const done = B.waitFor('event:transfer-complete', (m) => m.path === '/' + name, scaled(240000))
  await B.request('files:download', { spaceId, path: '/' + name, inPlace: true, ownerKey: aKey })
  const completion = await done
  t.comment(`${name}: ${mb} MB transferred in ${Date.now() - started}ms under the impaired link`)
  t.ok(fs.readFileSync(completion.localPath).equals(bytes), `${name}: byte-exact over the impaired link`)
  t.ok(!completion.localPath.endsWith('.overlay-partial'), `${name}: finalised, not a partial`)
}

// High-latency link: membership approval + a transfer must still converge.
test('membership converges and a transfer completes over a high-latency link', { timeout: scaled(300000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const aSrc = mkTmpDir(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), flags: v2flags(LINKS.transcontinental) })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags(LINKS.transcontinental) })
  const startedMembership = Date.now()
  const spaceId = await connectInSpaceWithApproval(t, A, B)
  t.comment(`membership converged in ${Date.now() - startedMembership}ms over the high-latency link`)
  const aKey = (await A.request('profile:get')).publicKey
  await shareSeeDownload(t, A, B, spaceId, aKey, aSrc, 'wan.bin', 8, 71)
  A.kill()
})

// Very high latency (satellite): a smaller transfer must still complete.
test('a transfer completes over a very-high-latency (satellite) link', { timeout: scaled(300000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const aSrc = mkTmpDir(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), flags: v2flags(LINKS.satellite) })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags(LINKS.satellite) })
  const spaceId = await connectInSpaceWithApproval(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey
  await shareSeeDownload(t, A, B, spaceId, aKey, aSrc, 'sat.bin', 4, 79)
  A.kill()
})

// Flaky link: the owner's connection drops every ~8-11s. Membership must converge in a between-
// drop window, and a transfer that spans several drops must auto-resume across reconnects.
test('a transfer completes over a flaky link that drops the connection repeatedly', { timeout: scaled(360000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const aSrc = mkTmpDir(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), flags: v2flags(LINKS.flaky) })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags(LINKS.transcontinental) })
  const spaceId = await connectInSpaceWithApproval(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey
  // 16 MB so the transfer spans multiple flap cycles → exercises reconnect + auto-resume.
  await shareSeeDownload(t, A, B, spaceId, aKey, aSrc, 'flap.bin', 16, 83)
  A.kill()
})
