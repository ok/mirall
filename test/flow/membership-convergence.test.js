import test from 'brittle'
import crypto from 'crypto'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
// v2 membership approval only engages in identity mode (createSpace gates v2 on a
// master secret), so these run identity-only — seed mode has no approval to converge.
const v2flags = () => ({ identityKEK: kekHex() })

const memberSetOf = async (peer, spaceId) => {
  const list = await peer.request('spaces:list')
  const s = list.find((x) => x.spaceId === spaceId)
  return new Set((s?.members || []).map((m) => m.publicKey))
}
const hasAll = (set, keys) => keys.every((k) => set.has(k))
// Sync predicate over a spaces:list result (until() does not await its predicate).
const seesMembers = (spaceId, keys) => (list) => {
  const s = list.find((x) => x.spaceId === spaceId)
  return hasAll(new Set((s?.members || []).map((m) => m.publicKey)), keys)
}

// REGRESSION: one member's approval must converge across ALL members. Before the fix,
// a co-member who didn't perform the approval kept showing "wants to join" and never
// admitted the joiner — member lists diverged across peers.
test('an approval converges across all members (owner + two joiners)', { timeout: 220000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const C = await launchPeer(t, { bootstrap, displayName: 'Carol', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })

  const space = await A.request('space:create', { name: 'Approval' })
  const sid = space.spaceId
  const aKey = (await A.request('profile:get')).publicKey
  const bKey = (await B.request('profile:get')).publicKey
  const cKey = (await C.request('profile:get')).publicKey
  const invite = await A.request('space:invite', { spaceId: sid })

  // B joins and is approved first → A and B are now co-members.
  const aSawB = A.waitFor('event:member-join-request', (m) => m.publicKey === bKey)
  await B.request('space:join', { inviteCode: invite })
  await aSawB
  await A.request('space:approve-member', { spaceId: sid, publicKey: bKey })
  await B.until('spaces:list', {}, (l) => l.find((s) => s.spaceId === sid)?.status === 'approved', { ms: 60000 })
  await A.until('spaces:list', {}, seesMembers(sid, [bKey]), { ms: 60000 })

  // C joins; the request reaches both co-members A and B.
  await C.request('space:join', { inviteCode: invite })
  await A.until('space:pending-requests', { spaceId: sid }, (r) => r.some((x) => x.publicKey === cKey), { ms: 90000 })
  await B.until('space:pending-requests', { spaceId: sid }, (r) => r.some((x) => x.publicKey === cKey), { ms: 90000 })

  // Only A approves C.
  await A.request('space:approve-member', { spaceId: sid, publicKey: cKey })

  // Convergence: every peer's member set contains the other two...
  await A.until('spaces:list', {}, seesMembers(sid, [bKey, cKey]), { ms: 120000 })
  await B.until('spaces:list', {}, seesMembers(sid, [aKey, cKey]), { ms: 120000 })
  await C.until('spaces:list', {}, seesMembers(sid, [aKey, bKey]), { ms: 120000 })
  t.ok(hasAll(await memberSetOf(A, sid), [bKey, cKey]), 'A sees B and C')
  t.ok(hasAll(await memberSetOf(B, sid), [aKey, cKey]), 'B (co-member, did NOT approve) sees A and C')
  t.ok(hasAll(await memberSetOf(C, sid), [aKey, bKey]), 'C sees A and B')

  // ...and no peer still shows a pending request.
  await A.until('space:pending-requests', { spaceId: sid }, (r) => r.length === 0, { ms: 30000 })
  await B.until('space:pending-requests', { spaceId: sid }, (r) => r.length === 0, { ms: 30000 })
  t.alike(await A.request('space:pending-requests', { spaceId: sid }), [], 'A: no stale request')
  t.alike(await B.request('space:pending-requests', { spaceId: sid }), [], 'B: stale "wants to join" cleared')
})

// REGRESSION: when a joiner withdraws (cancels) a pending request, the member who saw
// it must stop showing "wants to join" — the withdrawal gossips like approval/deny.
test('a cancelled join request clears on the member', { timeout: 150000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })

  const space = await A.request('space:create', { name: 'Approval' })
  const sid = space.spaceId
  const bKey = (await B.request('profile:get')).publicKey
  const invite = await A.request('space:invite', { spaceId: sid })

  const aSawB = A.waitFor('event:member-join-request', (m) => m.publicKey === bKey)
  await B.request('space:join', { inviteCode: invite })
  await aSawB
  t.ok((await A.request('space:pending-requests', { spaceId: sid })).some((r) => r.publicKey === bKey), 'A sees the request')

  // B withdraws by cancelling the pending join.
  await B.request('space:leave', { spaceId: sid })

  await A.until('space:pending-requests', { spaceId: sid }, (r) => !r.some((x) => x.publicKey === bKey), { ms: 30000 })
  t.absent((await A.request('space:pending-requests', { spaceId: sid })).some((r) => r.publicKey === bKey), 'B cancellation cleared A’s request')
})

// REGRESSION: a member denying a request must clear it on co-members too — otherwise a
// second member who saw the same request keeps a stale "wants to join".
test('a deny clears the request on co-members too', { timeout: 220000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const C = await launchPeer(t, { bootstrap, displayName: 'Carol', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })

  const space = await A.request('space:create', { name: 'Approval' })
  const sid = space.spaceId
  const bKey = (await B.request('profile:get')).publicKey
  const cKey = (await C.request('profile:get')).publicKey
  const invite = await A.request('space:invite', { spaceId: sid })

  const aSawB = A.waitFor('event:member-join-request', (m) => m.publicKey === bKey)
  await B.request('space:join', { inviteCode: invite })
  await aSawB
  await A.request('space:approve-member', { spaceId: sid, publicKey: bKey })
  await B.until('spaces:list', {}, (l) => l.find((s) => s.spaceId === sid)?.status === 'approved', { ms: 60000 })

  // C requests; both co-members A and B see it.
  await C.request('space:join', { inviteCode: invite })
  await A.until('space:pending-requests', { spaceId: sid }, (r) => r.some((x) => x.publicKey === cKey), { ms: 90000 })
  await B.until('space:pending-requests', { spaceId: sid }, (r) => r.some((x) => x.publicKey === cKey), { ms: 90000 })

  // A denies C → the co-member B must drop the request too.
  await A.request('space:deny-member', { spaceId: sid, publicKey: cKey })
  await B.until('space:pending-requests', { spaceId: sid }, (r) => !r.some((x) => x.publicKey === cKey), { ms: 30000 })
  t.absent((await B.request('space:pending-requests', { spaceId: sid })).some((r) => r.publicKey === cKey), 'co-member B no longer shows the denied request')
})

// REGRESSION: an auto-admit approval must converge to co-members the same way a manual
// approval does — they admit the joiner and drop the banner.
test('an auto-admit approval converges to co-members', { timeout: 220000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const C = await launchPeer(t, { bootstrap, displayName: 'Carol', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })

  const space = await A.request('space:create', { name: 'Approval' })
  const sid = space.spaceId
  const bKey = (await B.request('profile:get')).publicKey
  const cKey = (await C.request('profile:get')).publicKey
  const invite = await A.request('space:invite', { spaceId: sid })

  const aSawB = A.waitFor('event:member-join-request', (m) => m.publicKey === bKey)
  await B.request('space:join', { inviteCode: invite })
  await aSawB
  await A.request('space:approve-member', { spaceId: sid, publicKey: bKey })
  await B.until('spaces:list', {}, (l) => l.find((s) => s.spaceId === sid)?.status === 'approved', { ms: 60000 })

  // A issues an auto-admit invite; C redeems it → A admits with no prompt.
  const autoInvite = await A.request('space:invite', { spaceId: sid, autoAdmit: true })
  let aPrompted = false
  A.on('event:member-join-request', (m) => { if (m.publicKey === cKey) aPrompted = true })
  await C.request('space:join', { inviteCode: autoInvite })

  // The co-member B converges: admits C and shows no pending request for them.
  await B.until('spaces:list', {}, seesMembers(sid, [cKey]), { ms: 120000 })
  await B.until('space:pending-requests', { spaceId: sid }, (r) => !r.some((x) => x.publicKey === cKey), { ms: 30000 })
  t.absent(aPrompted, 'A auto-admitted C without a prompt')
  t.ok((await memberSetOf(B, sid)).has(cKey), 'co-member B admitted the auto-admitted joiner')
})

// Approval is monotonic: once a co-member has approved a joiner (SCK handed out),
// a different member's deny cannot revoke — it is a no-op (revocation needs key rotation).
test('deny is a no-op once a co-member has approved', { timeout: 220000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const C = await launchPeer(t, { bootstrap, displayName: 'Carol', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })

  const space = await A.request('space:create', { name: 'Approval' })
  const sid = space.spaceId
  const aKey = (await A.request('profile:get')).publicKey
  const bKey = (await B.request('profile:get')).publicKey
  const cKey = (await C.request('profile:get')).publicKey
  const invite = await A.request('space:invite', { spaceId: sid })

  const aSawB = A.waitFor('event:member-join-request', (m) => m.publicKey === bKey)
  await B.request('space:join', { inviteCode: invite })
  await aSawB
  await A.request('space:approve-member', { spaceId: sid, publicKey: bKey })
  await B.until('spaces:list', {}, (l) => l.find((s) => s.spaceId === sid)?.status === 'approved', { ms: 60000 })

  await C.request('space:join', { inviteCode: invite })
  await B.until('space:pending-requests', { spaceId: sid }, (r) => r.some((x) => x.publicKey === cKey), { ms: 90000 })
  await A.request('space:approve-member', { spaceId: sid, publicKey: cKey })
  await B.until('spaces:list', {}, seesMembers(sid, [aKey, cKey]), { ms: 120000 })

  // B tries to deny C after A already approved.
  const denied = await B.request('space:deny-member', { spaceId: sid, publicKey: cKey })
  t.absent(denied, 'deny of an already-approved member returns falsy (no-op)')
  t.ok((await memberSetOf(B, sid)).has(cKey), 'C remains a member on B')
  t.is((await C.request('spaces:list')).find((s) => s.spaceId === sid)?.status, 'approved', 'C is still approved')
})
