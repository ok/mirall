import test from 'brittle'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = () => ({ identityKEK: kekHex(), membershipApprovalEnabled: true })

// REGRESSION: C requests and goes OFFLINE before B ever joins, so B can only learn about C
// from A's replicated receipt — never from a live frame. On main B sees nothing; on branch B
// converges. This is the user's exact scenario (a co-member can't see a third peer waiting).
test('an approved co-member converges on an offline peer\'s pending request', { timeout: scaled(150000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const C = await launchPeer(t, { bootstrap, displayName: 'Carol', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })

  const space = await A.request('space:create', { name: 'Secret' })
  const bKey = (await B.request('profile:get')).publicKey
  const cKey = (await C.request('profile:get')).publicKey
  const invite = await A.request('space:invite', { spaceId: space.spaceId })

  // C requests first; A hears it and authors the durable receipt. Then C goes away.
  const aSawC = A.waitFor('event:member-join-request', (m) => m.spaceId === space.spaceId && m.publicKey === cKey)
  await C.request('space:join', { inviteCode: invite })
  await aSawC
  C.kill()

  // B joins and is approved → B becomes a real member holding the SCK and opens its member view.
  const aSawB = A.waitFor('event:member-join-request', (m) => m.publicKey === bKey)
  await B.request('space:join', { inviteCode: invite })
  await aSawB
  const bGranted = B.waitFor('event:membership-granted', (m) => m.spaceId === space.spaceId)
  await A.request('space:approve-member', { spaceId: space.spaceId, publicKey: bKey })
  await bGranted

  // B never saw C live (C was already offline) — it converges purely from A's replicated receipt.
  await B.until('space:pending-requests', { spaceId: space.spaceId },
    (r) => Array.isArray(r) && r.some((x) => x.publicKey === cKey), { ms: 90000, every: 500 })
  await B.until('spaces:list', {},
    (spaces) => (spaces.find((s) => s.spaceId === space.spaceId)?.pendingCount ?? 0) > 0, { ms: 90000, every: 500 })
  t.pass('B (a non-inviter co-member) sees C\'s pending request without C ever being online to B')
})

// Deny must converge on a co-member and stay cleared (durable tombstone, no resurrection).
test('a deny converges on a co-member and does not resurrect', { timeout: scaled(150000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const C = await launchPeer(t, { bootstrap, displayName: 'Carol', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })

  const space = await A.request('space:create', { name: 'Secret' })
  const bKey = (await B.request('profile:get')).publicKey
  const cKey = (await C.request('profile:get')).publicKey
  const invite = await A.request('space:invite', { spaceId: space.spaceId })

  const aSawB = A.waitFor('event:member-join-request', (m) => m.publicKey === bKey)
  await B.request('space:join', { inviteCode: invite })
  await aSawB
  const bGranted = B.waitFor('event:membership-granted', (m) => m.spaceId === space.spaceId)
  await A.request('space:approve-member', { spaceId: space.spaceId, publicKey: bKey })
  await bGranted

  const bSawC = B.waitFor('event:member-join-request', (m) => m.spaceId === space.spaceId && m.publicKey === cKey)
  await C.request('space:join', { inviteCode: invite })
  await bSawC
  await B.until('space:pending-requests', { spaceId: space.spaceId },
    (r) => Array.isArray(r) && r.some((x) => x.publicKey === cKey), { ms: 60000, every: 500 })

  const cDenied = C.waitFor('event:membership-denied', (m) => m.spaceId === space.spaceId)
  await A.request('space:deny-member', { spaceId: space.spaceId, publicKey: cKey })
  await cDenied

  await B.until('space:pending-requests', { spaceId: space.spaceId },
    (r) => Array.isArray(r) && !r.some((x) => x.publicKey === cKey), { ms: 60000, every: 500 })
  await new Promise((r) => setTimeout(r, 2000))
  const after = await B.request('space:pending-requests', { spaceId: space.spaceId })
  t.absent(after.some((x) => x.publicKey === cKey), 'C stays cleared on B (tombstone, no resurrection)')
})

// Owner-side convergence when a CO-MEMBER (not the owner) does the approval — the reported bug.
test('owner converges when a co-member approves a joiner (C online)', { timeout: scaled(150000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const C = await launchPeer(t, { bootstrap, displayName: 'Carol', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })

  const space = await A.request('space:create', { name: 'Secret' })
  const S = space.spaceId
  const bKey = (await B.request('profile:get')).publicKey
  const cKey = (await C.request('profile:get')).publicKey
  const invite = await A.request('space:invite', { spaceId: S })

  const aSawB = A.waitFor('event:member-join-request', (m) => m.publicKey === bKey)
  await B.request('space:join', { inviteCode: invite })
  await aSawB
  const bGranted = B.waitFor('event:membership-granted', (m) => m.spaceId === S)
  await A.request('space:approve-member', { spaceId: S, publicKey: bKey })
  await bGranted

  const bSawC = B.waitFor('event:member-join-request', (m) => m.spaceId === S && m.publicKey === cKey)
  await C.request('space:join', { inviteCode: invite })
  await bSawC
  const cGranted = C.waitFor('event:membership-granted', (m) => m.spaceId === S)
  await B.request('space:approve-member', { spaceId: S, publicKey: cKey })
  await cGranted

  // The OWNER (who did not approve) must see C as a member and must NOT show C as a pending approval.
  await A.until('spaces:list', {}, (sp) =>
    (sp.find((s) => s.spaceId === S)?.members || []).some((m) => m.publicKey === cKey), { ms: 60000, every: 500 })
  await A.until('space:pending-requests', { spaceId: S },
    (r) => Array.isArray(r) && !r.some((x) => x.publicKey === cKey), { ms: 60000, every: 500 })
  const sp = (await A.request('spaces:list')).find((s) => s.spaceId === S)
  t.is(sp.pendingCount ?? 0, 0, 'owner shows no pending approval for the now-joined member')
  t.pass('owner converged on the co-member-approved joiner')
})

// REGRESSION: the joiner goes offline right after the grant. The owner's pending must clear (member-
// aware read) AND the owner must converge on the joiner as a member — the approver captured the
// joiner's complete record at approval (captureJoinerMembership) and serves it onward, so convergence
// is deterministic, not a slow eventual race (#231).
test('owner converges on a co-member approval with the joiner offline', { timeout: scaled(180000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const C = await launchPeer(t, { bootstrap, displayName: 'Carol', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })

  const space = await A.request('space:create', { name: 'Secret' })
  const S = space.spaceId
  const bKey = (await B.request('profile:get')).publicKey
  const cKey = (await C.request('profile:get')).publicKey
  const invite = await A.request('space:invite', { spaceId: S })

  const aSawB = A.waitFor('event:member-join-request', (m) => m.publicKey === bKey)
  await B.request('space:join', { inviteCode: invite })
  await aSawB
  const bGranted = B.waitFor('event:membership-granted', (m) => m.spaceId === S)
  await A.request('space:approve-member', { spaceId: S, publicKey: bKey })
  await bGranted

  const bSawC = B.waitFor('event:member-join-request', (m) => m.spaceId === S && m.publicKey === cKey)
  await C.request('space:join', { inviteCode: invite })
  await bSawC
  const cGranted = C.waitFor('event:membership-granted', (m) => m.spaceId === S)
  await B.request('space:approve-member', { spaceId: S, publicKey: cKey })
  await cGranted
  C.kill()

  // Fix 1 (hard, fast): the owner's pending must clear even though C never gate-admitted A.
  await A.until('space:pending-requests', { spaceId: S },
    (r) => Array.isArray(r) && !r.some((x) => x.publicKey === cKey), { ms: 60000, every: 500 })
  // The owner converges on C as a member — pulled from B, which holds C's complete record (captured
  // at approval). Generous ceiling, matching Fix-1 above; #230 had tightened this to 30000 to fail a
  // stalled convergence fast for the retry net — no longer needed now that convergence is reliable.
  await A.until('spaces:list', {}, (sp) =>
    (sp.find((s) => s.spaceId === S)?.members || []).some((m) => m.publicKey === cKey), { ms: 60000, every: 1000 })
  t.pass('owner converged on offline C as a member; pending cleared')
})

// The owner approves BOTH joiners from one shared manual invite, and must converge on both as
// members with nothing left pending. Guards the gate honoring the owner's OWN approval (a joiner the
// owner approved must not get bounced back to pending when the fold momentarily lacks their record).
test('owner converges on two joiners it approved from one manual invite', { timeout: scaled(150000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const C = await launchPeer(t, { bootstrap, displayName: 'Carol', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })

  const space = await A.request('space:create', { name: 'Secret' })
  const S = space.spaceId
  const bKey = (await B.request('profile:get')).publicKey
  const cKey = (await C.request('profile:get')).publicKey
  const invite = await A.request('space:invite', { spaceId: S })   // one manual invite, shared with both

  const aSawB = A.waitFor('event:member-join-request', (m) => m.publicKey === bKey)
  const aSawC = A.waitFor('event:member-join-request', (m) => m.publicKey === cKey)
  await B.request('space:join', { inviteCode: invite })
  await C.request('space:join', { inviteCode: invite })
  await aSawB
  await aSawC

  await A.request('space:approve-member', { spaceId: S, publicKey: bKey })
  await A.request('space:approve-member', { spaceId: S, publicKey: cKey })

  // Owner must end up with BOTH as members and nothing pending — no joiner bounced back to pending.
  await A.until('spaces:list', {}, (sp) => {
    const mem = (sp.find((s) => s.spaceId === S)?.members || []).map((m) => m.publicKey)
    return mem.includes(bKey) && mem.includes(cKey)
  }, { ms: 90000, every: 500 })
  await A.until('space:pending-requests', { spaceId: S }, (r) => Array.isArray(r) && r.length === 0, { ms: 90000, every: 500 })
  t.pass('owner sees both approved joiners as members, nothing pending')
})
