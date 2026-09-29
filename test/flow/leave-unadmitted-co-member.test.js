import test from 'brittle'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval, waitForWorkerExit } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// Bob joins on Carol's approval and holds Alice, the inviter, unverified: he has not admitted her,
// so his side of their socket replicates nothing. Carol is killed before Bob leaves, which leaves
// Bob himself as the only source of his departure while Alice still holds Carol's dead socket.
// Alice's fold is held back so she never follows Bob's bee through Carol first: her leave handler
// has to read it from Bob.
const FOLD_WAIT_MS = scaled(120000)

const inRoster = (sid, key, want) => (l) =>
  ((l.find((x) => x.spaceId === sid)?.members || []).some((m) => m.publicKey === key)) === want

async function kill(peer) {
  const pid = peer.sidecar?._process?.pid
  peer.kill()
  if (pid) await waitForWorkerExit(pid, 5000)
}

async function joinedThroughCarol(t) {
  const bootstrap = await localTestnet(t)
  const aDirs = { storage: path.join(mkTmpDir(t), 'app-storage'), downloads: mkTmpDir(t) }
  const launchAlice = () => launchPeer(t, { bootstrap, displayName: 'Alice', ...aDirs, flags: { deriveDebounceMs: FOLD_WAIT_MS } })
  const aliceUp = Date.now()
  const A = await launchAlice()
  const C = await launchPeer(t, { bootstrap, displayName: 'Carol', storage: path.join(mkTmpDir(t), 'app-storage'), downloads: mkTmpDir(t) })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: path.join(mkTmpDir(t), 'app-storage'), downloads: mkTmpDir(t) })
  const sid = await connectInSpaceWithApproval(t, A, C)
  const bKey = (await B.request('profile:get')).personKey

  const invite = await A.request('space:invite', { spaceId: sid })
  const bGranted = B.waitFor('event:membership-granted', (m) => m.spaceId === sid, 120000)
  await B.request('space:join', { inviteCode: invite })
  await C.until('space:pending-requests', { spaceId: sid }, (r) => r.some((x) => x.publicKey === bKey), { ms: 60000 })
  await C.request('space:approve-member', { spaceId: sid, publicKey: bKey })
  await bGranted
  await A.until('spaces:list', {}, inRoster(sid, bKey, true), { ms: 120000, every: 500 })
  await kill(C)
  return { A, B, sid, bKey, aliceUp, launchAlice }
}

test('REGRESSION (FIX-551: a leave reaches a co-member the leaver never admitted)', { timeout: scaled(300000) }, async (t) => {
  const { A, B, sid, bKey, aliceUp } = await joinedThroughCarol(t)

  await B.request('space:leave', { spaceId: sid })
  await A.until('spaces:list', {}, inRoster(sid, bKey, false), { ms: 60000, every: 500 })
  t.ok(Date.now() - aliceUp < FOLD_WAIT_MS, 'Alice dropped Bob before her fold could follow his bee')
})

test('REGRESSION (FIX-551: a replayed leave reaches a co-member that never held the leaver\'s record)', { timeout: scaled(360000) }, async (t) => {
  const { A, B, sid, bKey, launchAlice } = await joinedThroughCarol(t)

  await kill(A)
  await B.request('space:leave', { spaceId: sid })
  t.absent((await B.request('spaces:list', {})).some((s) => s.spaceId === sid), 'precondition: Bob left while nobody was connected')

  const aliceBack = Date.now()
  const A2 = await launchAlice()
  t.ok(inRoster(sid, bKey, true)(await A2.request('spaces:list', {})), 'precondition: Alice still holds Bob')
  await A2.until('spaces:list', {}, inRoster(sid, bKey, false), { ms: 60000, every: 500 })
  t.ok(Date.now() - aliceBack < FOLD_WAIT_MS, 'Alice dropped Bob on the replayed frame, before her fold could follow his bee')
})
