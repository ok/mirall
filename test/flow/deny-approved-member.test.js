import test from 'brittle'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval, waitForWorkerExit } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const peer = (t, bootstrap, displayName, flags = {}) =>
  launchPeer(t, { bootstrap, displayName, storage: idStore(t), downloads: mkTmpDir(t), flags })

const kindsOf = async (p) => (await p.request('audit:list', { limit: 200 })).entries.map((e) => e.kind)
const countOf = (kinds, kind) => kinds.filter((k) => k === kind).length
const listed = async (p, spaceId, key) => (await p.request('space:pending-requests', { spaceId })).some((r) => r.publicKey === key)

// Approval is monotonic until the content key can be rotated: a deny aimed at a peer who already
// holds it cannot take anything back, so the decider must hear that rather than a bare false.
test('REGRESSION (FIX-395A: deny on an approved member reports nothing)', { timeout: scaled(220000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await peer(t, bootstrap, 'Alice')
  const B = await peer(t, bootstrap, 'Bob')

  const sid = await connectInSpaceWithApproval(t, A, B)
  const bKey = (await B.request('profile:get')).personKey

  const res = await A.request('space:deny-member', { spaceId: sid, publicKey: bKey })
  t.alike(res, { outcome: 'already-approved' }, 'the decider is told the peer is already a member')

  const members = (await A.request('spaces:list')).find((s) => s.spaceId === sid)?.members || []
  t.ok(members.some((m) => m.publicKey === bKey), 'Bob stays a member')
  t.is((await B.request('spaces:list')).find((s) => s.spaceId === sid)?.status, 'approved', 'Bob keeps access')
  t.absent((await kindsOf(A)).includes('membership.denied'), 'no denial is recorded for a deny that changed nothing')
})

// Alice's fold trails every write by far longer than the steps below take, so Carol's approval is
// visible to Alice's admission read while Alice still lists Bob's request — the stale banner a
// user actually clicks Deny on.
test('REGRESSION (FIX-395A: a deny racing a co-member approval leaves the request listed)', { timeout: scaled(300000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await peer(t, bootstrap, 'Alice', { deriveDebounceMs: scaled(20000) })
  const C = await peer(t, bootstrap, 'Carol')
  const B = await peer(t, bootstrap, 'Bob')

  const sid = await connectInSpaceWithApproval(t, A, C)
  const bKey = (await B.request('profile:get')).personKey
  const inviteCode = await A.request('space:invite', { spaceId: sid })
  const aGotRequest = A.waitFor('event:member-join-request', (m) => m.spaceId === sid && m.publicKey === bKey, 120000)
  await B.request('space:join', { inviteCode })
  await aGotRequest
  await C.until('space:pending-requests', { spaceId: sid }, (r) => r.some((x) => x.publicKey === bKey), { ms: 60000 })

  // Offline, Bob cannot handshake his way into Alice's roster once Carol lets him in.
  const bPid = B.sidecar?._process?.pid
  B.kill()
  if (bPid) await waitForWorkerExit(bPid, 5000)

  await C.request('space:approve-member', { spaceId: sid, publicKey: bKey })
  await new Promise((r) => setTimeout(r, scaled(2000)))
  t.ok(await listed(A, sid, bKey), 'precondition: Alice still lists the request her fold has not settled')

  const res = await A.request('space:deny-member', { spaceId: sid, publicKey: bKey })
  t.alike(res, { outcome: 'already-approved' }, 'the approval Carol recorded wins over the stale banner')
  t.absent(await listed(A, sid, bKey), 'the request is gone at once, not after the fold catches up')
  t.absent((await kindsOf(A)).includes('membership.denied'), 'no denial is recorded')
})

test('REGRESSION (FIX-395C: approving an approved member records the approval again)', { timeout: scaled(220000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await peer(t, bootstrap, 'Alice')
  const B = await peer(t, bootstrap, 'Bob')
  const sid = await connectInSpaceWithApproval(t, A, B)
  const bKey = (await B.request('profile:get')).personKey
  await A.until('audit:list', { limit: 200 }, (p) => p.entries.some((e) => e.kind === 'membership.approved'))

  t.is(await A.request('space:approve-member', { spaceId: sid, publicKey: bKey }), false, 'nothing new is granted')
  t.is(countOf(await kindsOf(A), 'membership.approved'), 1, 'the approval is recorded once')
})

test('REGRESSION (FIX-395D: a deny with no open request still denies)', { timeout: scaled(220000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await peer(t, bootstrap, 'Alice')
  const B = await peer(t, bootstrap, 'Bob')
  const space = await A.request('space:create', { name: 'Closed' })
  const sid = space.spaceId

  t.alike(await A.request('space:deny-member', { spaceId: sid, publicKey: 'a'.repeat(64) }), { outcome: 'not-applicable' },
    'a key that never asked is not denied')

  const inviteCode = await A.request('space:invite', { spaceId: sid })
  const aGotRequest = A.waitFor('event:member-join-request', (m) => m.spaceId === sid, 120000)
  await B.request('space:join', { inviteCode })
  const req = await aGotRequest
  t.alike(await A.request('space:deny-member', { spaceId: sid, publicKey: req.publicKey }), { outcome: 'denied' }, 'the open request is denied')
  t.alike(await A.request('space:deny-member', { spaceId: sid, publicKey: req.publicKey }), { outcome: 'not-applicable' },
    'a second deny finds nothing open')
  await A.until('audit:list', { limit: 200 }, (p) => p.entries.some((e) => e.kind === 'membership.denied'))
  t.is(countOf(await kindsOf(A), 'membership.denied'), 1, 'one denial is recorded')
})
