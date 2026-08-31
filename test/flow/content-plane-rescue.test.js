import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// REGRESSION (FIX-9: a download interrupted by a dropped connection never resumed).
//
// Both halves of the bug are exercised here, because a link this hostile hits both:
//   1. every reconnect used to fire a resume that the presence gate silently dropped (the trigger
//      rode the bulk plane, the gate read the control plane, and the two are never up together
//      right after a drop);
//   2. hyperswarm stops re-dialing a peer whose connections keep dying young, and the bulk plane
//      had no way back — its only discovery refresh hung off a manual Reconnect.
//
// Sizing matters. The flap interval sits BELOW hyperswarm's prove-yourself window, so the dialer
// burns through its retries within a few cycles; the payload is large enough that the transfer is
// still unfinished by then, so finishing REQUIRES surviving the cliff. The test asserts the drops
// actually landed mid-transfer — a payload that slipped through between flaps would otherwise pass
// while testing nothing. The shrunk convergence tick keeps the rescue inside the budget; production
// uses the 15s default.

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')

const FLAP_MS = 6000
const HOSTILE_LINK = { latencyMs: 200, jitterMs: 150, flapEveryMs: FLAP_MS, flapJitterMs: 1000 }
const flags = () => ({
  overlayEnabled: true,
  inPlaceFilesEnabled: true,
  identityKEK: kekHex(),
  netImpair: HOSTILE_LINK,
  convergenceTickMs: 3000,
})

test('a download survives a link that flaps until hyperswarm gives up re-dialing', { timeout: scaled(420000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const aSrc = mkTmpDir(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), flags: flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })
  const spaceId = await connectInSpaceWithApproval(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey

  // Big enough that it cannot complete inside the handful of flap cycles hyperswarm tolerates
  // before it stops re-dialing — so the download can only finish by being rescued and resumed.
  // Not bigger: each recovery cycle only moves a few MB on this link, so a larger payload measures
  // throughput-under-adversity (and races the budget) instead of the recovery this test is for.
  const bytes = patternedBytes(32 * 1024 * 1024, 91)
  fs.writeFileSync(path.join(aSrc, 'churn.bin'), bytes)
  await A.request('files:add', { spaceId, filePath: path.join(aSrc, 'churn.bin'), fileName: 'churn.bin', fileSize: bytes.length })
  await B.until('files:list', { spaceId },
    (f) => Array.isArray(f) && f.some((e) => e.path === '/churn.bin' && e.status === 'remote'), { ms: 180000 })

  let interruptions = 0
  B.on('event:transfer-paused', (m) => { if (m.path === '/churn.bin') interruptions++ })

  const started = Date.now()
  const done = B.waitFor('event:transfer-complete', (m) => m.path === '/churn.bin', 300000)
  await B.request('files:download', { spaceId, path: '/churn.bin', inPlace: true, ownerKey: aKey })
  const completion = await done
  const elapsed = Date.now() - started

  t.comment(`completed in ${elapsed}ms across ${interruptions} interruption(s)`)
  t.ok(interruptions > 0, 'the link actually dropped mid-transfer — the scenario under test really happened')
  t.ok(elapsed > FLAP_MS, 'the transfer outlived at least one flap cycle (it did not slip through between drops)')
  t.ok(fs.readFileSync(completion.localPath).equals(bytes), 'the interrupted download resumed and landed byte-exact')
  A.kill()
})
