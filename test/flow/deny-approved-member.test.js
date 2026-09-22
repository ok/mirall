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

// Alice's membership fold first runs FOLD_WAIT_MS after her space opens, so Carol's approval is
// visible to Alice's admission read while Alice still lists Bob's request — the stale banner a user
// actually clicks Deny on. The steps assert they finished inside that window rather than trust it.
const FOLD_WAIT_MS = scaled(120000)

test('REGRESSION (FIX-395A: a deny racing a co-member approval leaves the request listed)', { timeout: scaled(300000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const aliceUp = Date.now()
  const A = await peer(t, bootstrap, 'Alice', { deriveDebounceMs: FOLD_WAIT_MS })
  const C = await peer(t, bootstrap, 'Carol')
  const bDirs = { storage: idStore(t), downloads: mkTmpDir(t) }
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', ...bDirs })

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
  t.ok(Date.now() - aliceUp < FOLD_WAIT_MS, 'precondition: Alice\'s membership fold has not run yet')
  t.ok(await listed(A, sid, bKey), 'precondition: Alice still lists the request')

  const res = await A.request('space:deny-member', { spaceId: sid, publicKey: bKey })
  t.alike(res, { outcome: 'already-approved' }, 'the approval Carol recorded wins over the stale banner')
  t.absent(await listed(A, sid, bKey), 'the request is gone at once, not after the fold catches up')
  t.absent((await kindsOf(A)).includes('membership.denied'), 'no denial is recorded')

  // The live row is gone and Alice's fold still has not run, so only the remembered answer can
  // say already-approved here; without it the repeat reads as a closed request.
  t.alike(await A.request('space:deny-member', { spaceId: sid, publicKey: bKey }), { outcome: 'already-approved' },
    'a repeated deny gives the same answer')

  // With Carol gone only Alice answers Bob's next knock: a denial tombstone would turn it away with
  // a deny frame, where no tombstone sends it to review as a fresh request.
  const cPid = C.sidecar?._process?.pid
  C.kill()
  if (cPid) await waitForWorkerExit(cPid, 5000)
  const aSawKnock = A.waitFor('event:member-join-request', (m) => m.spaceId === sid && m.publicKey === bKey, 120000)
  const B2 = await launchPeer(t, { bootstrap, displayName: 'Bob', ...bDirs })
  let bDenied = false
  B2.on('event:membership-denied', (m) => { if (m.spaceId === sid) bDenied = true })
  await t.execution(aSawKnock, 'Bob\'s next knock reaches review: Alice wrote no denial')
  t.absent(bDenied, 'Bob received no deny')
  t.is((await B2.request('spaces:list')).find((x) => x.spaceId === sid)?.status, 'pending', 'Bob still holds the space')
})

// Carol approved Bob and went offline, so her approval survives Bob's leave. Alice must still be
// able to let Bob back in: a stale approval is not a reason to skip writing a fresh one or to
// withhold the key.
test('REGRESSION (FIX-395F: approving a rejoining leaver sends no key)', { timeout: scaled(400000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await peer(t, bootstrap, 'Alice')
  const C = await peer(t, bootstrap, 'Carol')
  const B = await peer(t, bootstrap, 'Bob')
  const sid = await connectInSpaceWithApproval(t, A, C)
  const bKey = (await B.request('profile:get')).personKey
  const inRoster = (key, want) => (l) => ((l.find((x) => x.spaceId === sid)?.members || []).some((m) => m.publicKey === key)) === want

  const invite = await A.request('space:invite', { spaceId: sid })
  const bGranted = B.waitFor('event:membership-granted', (m) => m.spaceId === sid, 120000)
  await B.request('space:join', { inviteCode: invite })
  await C.until('space:pending-requests', { spaceId: sid }, (r) => r.some((x) => x.publicKey === bKey), { ms: 60000 })
  await C.request('space:approve-member', { spaceId: sid, publicKey: bKey })
  await bGranted
  await A.until('spaces:list', {}, inRoster(bKey, true), { ms: 120000, every: 1000 })

  const cPid = C.sidecar?._process?.pid
  C.kill()
  if (cPid) await waitForWorkerExit(cPid, 5000)
  await B.request('space:leave', { spaceId: sid })
  await A.until('spaces:list', {}, inRoster(bKey, false), { ms: 120000, every: 1000 })

  const aGotRejoin = A.waitFor('event:member-join-request', (m) => m.spaceId === sid && m.publicKey === bKey, 120000)
  const bRegranted = B.waitFor('event:membership-granted', (m) => m.spaceId === sid, 120000)
  await B.request('space:join', { inviteCode: invite })
  await aGotRejoin
  const res = await A.request('space:approve-member', { spaceId: sid, publicKey: bKey })
  t.ok(res && res.granted, 'Alice\'s approval is recorded')
  await t.execution(bRegranted, 'Bob receives the key again')
})

test('REGRESSION (FIX-395D: a deny with no open request still denies)', { timeout: scaled(220000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await peer(t, bootstrap, 'Alice')
  const B = await peer(t, bootstrap, 'Bob')
  const space = await A.request('space:create', { name: 'Closed' })
  const sid = space.spaceId

  t.alike(await A.request('space:deny-member', { spaceId: sid, publicKey: 'a'.repeat(64) }), { outcome: 'not-applicable' },
    'a key that never asked is not denied')
  await t.exception(() => A.request('space:deny-member', { spaceId: 'no-such-space', publicKey: 'a'.repeat(64) }), /not found/i,
    'a space that is gone is an error, not a closed request')
  await t.exception(() => A.request('space:approve-member', { spaceId: 'no-such-space', publicKey: 'a'.repeat(64) }), /not found/i,
    'approve says so too, rather than a silent false')

  const inviteCode = await A.request('space:invite', { spaceId: sid })
  const aGotRequest = A.waitFor('event:member-join-request', (m) => m.spaceId === sid, 120000)
  await B.request('space:join', { inviteCode })
  const req = await aGotRequest
  t.alike(await A.request('space:deny-member', { spaceId: sid, publicKey: req.publicKey }), { outcome: 'denied' }, 'the open request is denied')
  const refreshed = A.waitFor('event:join-requests-updated', (m) => m.spaceId === sid, 10000)
  t.alike(await A.request('space:deny-member', { spaceId: sid, publicKey: req.publicKey }), { outcome: 'not-applicable' },
    'a second deny finds nothing open')
  await t.execution(refreshed, 'a stale Deny row is told to refetch')
  await A.until('audit:list', { limit: 200 }, (p) => p.entries.some((e) => e.kind === 'membership.denied'))
  t.is(countOf(await kindsOf(A), 'membership.denied'), 1, 'one denial is recorded')
})
