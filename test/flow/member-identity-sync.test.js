import test from 'brittle'
import crypto from 'crypto'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'

// Identity (displayName + avatar) and presence (online) must converge to the same authority the
// roster uses — replicated records — not a live point-to-point handshake. Before the fix a derived
// member we had no admitted handshake with rendered as "Unknown"/initials/offline even while present.

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = () => ({ identityKEK: kekHex() })

const launch = (t, name, bootstrap) =>
  launchPeer(t, { bootstrap, displayName: name, storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
const keyOf = async (peer) => (await peer.request('profile:get')).publicKey
const memberOf = (spaceId, key) => (list) =>
  (list.find((x) => x.spaceId === spaceId)?.members || []).find((m) => m.publicKey === key)
// Avatars ride the full space:members roster (spaces:list rosters are slim).
const hasIdentity = (key, name, avatar) => (roster) => {
  const m = (Array.isArray(roster) ? roster : []).find((x) => x.publicKey === key)
  return !!m && m.displayName === name && m.avatar === avatar
}

async function joinAndApprove (t, owner, joiner, sid, invite) {
  const jKey = await keyOf(joiner)
  const saw = owner.waitFor('event:member-join-request', (m) => m.publicKey === jKey)
  await joiner.request('space:join', { inviteCode: invite })
  await saw
  await owner.request('space:approve-member', { spaceId: sid, publicKey: jKey })
  await owner.until('spaces:list', {},
    (list) => new Set((list.find((x) => x.spaceId === sid)?.members || []).map((m) => m.publicKey)).has(jKey),
    { ms: 60000 })
  return jKey
}

test('approved joiner sees the approver name + avatar', { timeout: 180000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launch(t, 'Alice', bootstrap)
  const B = await launch(t, 'Bob', bootstrap)
  await A.request('profile:set', { displayName: 'Alice', avatar: 'data:image/png;base64,ALICE' })

  const space = await A.request('space:create', { name: 'Approval Test' })
  const sid = space.spaceId
  const aKey = await keyOf(A)
  const invite = await A.request('space:invite', { spaceId: sid })

  await joinAndApprove(t, A, B, sid, invite)

  await B.until('space:members', { spaceId: sid }, hasIdentity(aKey, 'Alice', 'data:image/png;base64,ALICE'), { ms: 120000 })
  t.pass('approver identity (name + avatar) converged on the joiner')
})

test('a late joiner sees a pre-existing member name + avatar + online', { timeout: 240000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launch(t, 'Alice', bootstrap)
  const B = await launch(t, 'Bob', bootstrap)
  await A.request('profile:set', { displayName: 'Alice', avatar: 'data:image/png;base64,ALICE' })
  await B.request('profile:set', { displayName: 'Bob', avatar: 'data:image/png;base64,BOB' })

  const space = await A.request('space:create', { name: 'Approval Test' })
  const sid = space.spaceId
  const aKey = await keyOf(A)
  const invite = await A.request('space:invite', { spaceId: sid })

  // A and B become co-members BEFORE C exists.
  const bKey = await joinAndApprove(t, A, B, sid, invite)

  // C joins late — it derives B purely from records, having never seen B's approval.
  const C = await launch(t, 'Carol', bootstrap)
  await joinAndApprove(t, A, C, sid, invite)

  // REGRESSION: B must render with its real name + avatar on C (not "Unknown"/initials)...
  await C.until('space:members', { spaceId: sid }, hasIdentity(bKey, 'Bob', 'data:image/png;base64,BOB'), { ms: 150000 })
  await C.until('space:members', { spaceId: sid }, hasIdentity(aKey, 'Alice', 'data:image/png;base64,ALICE'), { ms: 150000 })
  // ...and converge to online (presence establishes even if the first handshake raced the records).
  await C.until('members:online', { spaceId: sid }, (o) => o.includes(bKey) && o.includes(aKey), { ms: 150000 })
  t.pass('late joiner sees pre-existing members with identity + online')
})

test('REGRESSION (FIX-MIR-12): an over-long peer display name arrives clamped', { timeout: 180000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launch(t, 'Alice', bootstrap)
  const B = await launch(t, 'Bob', bootstrap)
  await A.request('profile:set', { displayName: 'A'.repeat(200), avatar: 'data:image/png;base64,ALICE' })

  const space = await A.request('space:create', { name: 'Cap Test' })
  const sid = space.spaceId
  const aKey = await keyOf(A)
  const invite = await A.request('space:invite', { spaceId: sid })
  await joinAndApprove(t, A, B, sid, invite)

  await B.until('spaces:list', {},
    (list) => { const m = memberOf(sid, aKey)(list); return !!m && m.displayName.length === 80 },
    { ms: 120000 })
  t.pass('over-long display name clamped to 80 on the co-member')
})
