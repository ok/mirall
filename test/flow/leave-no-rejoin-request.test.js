import test from 'brittle'
import crypto from 'crypto'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = () => ({ identityKEK: kekHex(), membershipApprovalEnabled: true })
const launch = (t, name, bootstrap) =>
  launchPeer(t, { bootstrap, displayName: name, storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
const keyOf = async (peer) => (await peer.request('profile:get')).publicKey
const hasMember = (sid, key) => (list) => {
  const s = list.find((x) => x.spaceId === sid)
  return !!(s && (s.members || []).some((m) => m.publicKey === key))
}

// BUG: an approved member who LEAVES a v2 (approval-required) space must not linger as a
// member nor reappear as a pending join request on the remaining members. (Reported: a
// leaver "automatically shows up as he wants to join again".) Root cause: the leaver's
// `del member/S` may not replicate before they disconnect during teardown, so the member
// fold re-reads their stale active record and re-adds them; a subsequent stray handshake
// then trips the gate into a fresh join request. The leave FRAME is the reliable signal —
// a "left" tombstone makes the fold and the gate honor it.
test('REGRESSION: an approved member who leaves does not linger or reappear as a join request', { timeout: scaled(220000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launch(t, 'Alice', bootstrap)
  const B = await launch(t, 'Bob', bootstrap)
  const sid = await connectInSpaceWithApproval(t, A, B, 'Approval')
  const bKey = await keyOf(B)

  // B is now a full member. B leaves.
  await B.request('space:leave', { spaceId: sid })

  // A drops B from the member list and keeps it dropped (the fold must not re-add B).
  await A.until('spaces:list', {}, (l) => !hasMember(sid, bKey)(l), { ms: 30000 })

  // Let any stray re-handshake / re-derive settle, then assert B is gone AND not a request.
  await new Promise((r) => setTimeout(r, 6000))
  t.absent(hasMember(sid, bKey)(await A.request('spaces:list', {})), 'B stays removed from members')
  t.absent((await A.request('space:pending-requests', { spaceId: sid })).some((r) => r.publicKey === bKey),
    'B does NOT reappear as a "wants to join" request after leaving')
})

// Companion: a member who left can cleanly REJOIN (the tombstone is lifted by a fresh
// join request) — the fix must not strand a returning member.
test('a member who left can rejoin cleanly afterwards', { timeout: scaled(240000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launch(t, 'Alice', bootstrap)
  const B = await launch(t, 'Bob', bootstrap)
  const sid = await connectInSpaceWithApproval(t, A, B, 'Approval')
  const bKey = await keyOf(B)
  const invite = await A.request('space:invite', { spaceId: sid })

  await B.request('space:leave', { spaceId: sid })
  await A.until('spaces:list', {}, (l) => !hasMember(sid, bKey)(l), { ms: 30000 })

  // B rejoins via a fresh invite redemption → A must see the request again, approve, converge.
  const aGotRequest = A.waitFor('event:member-join-request', (m) => m.publicKey === bKey)
  await B.request('space:join', { inviteCode: invite })
  await aGotRequest
  await A.request('space:approve-member', { spaceId: sid, publicKey: bKey })
  await A.until('spaces:list', {}, hasMember(sid, bKey), { ms: 30000 })
  t.ok(hasMember(sid, bKey)(await A.request('spaces:list', {})), 'B is a member again after rejoining')
})
