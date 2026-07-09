import test from 'brittle'
import crypto from 'crypto'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'

// New phase-(a) coverage (state-reconciliation §5): a late joiner derives the existing
// roster purely from replicated records (the bespoke approval gossip is gone), and Tier-1
// membership is decoupled from Tier-2 liveness (a peer that vanishes without leaving stays
// a member but shows offline — the deliberate "membership ≠ liveness" change that replaced
// the witness prune).

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = () => ({ identityKEK: kekHex(), membershipApprovalEnabled: true })

const launch = (t, name, bootstrap) =>
  launchPeer(t, { bootstrap, displayName: name, storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
const keyOf = async (peer) => (await peer.request('profile:get')).publicKey
const memberSetOf = async (peer, spaceId) =>
  new Set(((await peer.request('spaces:list')).find((x) => x.spaceId === spaceId)?.members || []).map((m) => m.publicKey))
const seesMembers = (spaceId, keys) => (list) => {
  const set = new Set((list.find((x) => x.spaceId === spaceId)?.members || []).map((m) => m.publicKey))
  return keys.every((k) => set.has(k))
}

// Join `joiner` to a space owned by `owner` and approve it, returning when the owner lists it.
async function joinAndApprove (t, owner, joiner, sid, invite) {
  const jKey = await keyOf(joiner)
  const saw = owner.waitFor('event:member-join-request', (m) => m.publicKey === jKey)
  await joiner.request('space:join', { inviteCode: invite })
  await saw
  await owner.request('space:approve-member', { spaceId: sid, publicKey: jKey })
  await owner.until('spaces:list', {}, seesMembers(sid, [jKey]), { ms: 60000 })
  return jKey
}

test('a late joiner derives the pre-existing roster from records (no gossip)', { timeout: 240000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launch(t, 'Alice', bootstrap)
  const B = await launch(t, 'Bob', bootstrap)
  const space = await A.request('space:create', { name: 'Roster' })
  const sid = space.spaceId
  const aKey = await keyOf(A)
  const invite = await A.request('space:invite', { spaceId: sid })

  // A and B become co-members BEFORE C exists.
  const bKey = await joinAndApprove(t, A, B, sid, invite)

  // C joins LATE — it never witnessed B's approval; it must derive B from records alone.
  const C = await launch(t, 'Carol', bootstrap)
  const cKey = await joinAndApprove(t, A, C, sid, invite)

  await C.until('spaces:list', {}, seesMembers(sid, [aKey, bKey]), { ms: 150000 })
  t.ok((await memberSetOf(C, sid)).has(aKey), 'late joiner C sees the creator A')
  t.ok((await memberSetOf(C, sid)).has(bKey), 'late joiner C sees pre-existing member B it never interacted with at approval time')
  t.ok((await memberSetOf(A, sid)).has(cKey), 'A sees the late joiner C')
})

test('a member that vanishes without leaving stays in the roster but shows offline', { timeout: 240000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launch(t, 'Alice', bootstrap)
  const B = await launch(t, 'Bob', bootstrap)
  const space = await A.request('space:create', { name: 'Liveness' })
  const sid = space.spaceId
  const invite = await A.request('space:invite', { spaceId: sid })

  const bKey = await joinAndApprove(t, A, B, sid, invite)
  await A.until('members:online', { spaceId: sid }, (o) => o.includes(bKey), { ms: 60000 })

  // REGRESSION (FIX-EDA-16): members:online includes the caller — the local peer never leases
  // itself in presence, so the worker adds self rather than every consumer re-deriving it.
  const aKey = await keyOf(A)
  t.ok((await A.request('members:online', { spaceId: sid })).includes(aKey), 'the online set includes self')

  // B disappears WITHOUT leaving — no leave frame, no `del member/S`. The old witness
  // prune would have eventually ghosted it; now Tier-1 membership persists.
  B.kill()
  await A.until('members:online', { spaceId: sid }, (o) => !o.includes(bKey), { ms: 90000 })

  t.ok((await memberSetOf(A, sid)).has(bKey), 'B stays in the roster (Tier-1 membership ≠ liveness)')
  t.absent((await A.request('members:online', { spaceId: sid })).includes(bKey), 'B shows offline (Tier-2 lease expired/cleared)')
  t.ok((await A.request('members:online', { spaceId: sid })).includes(aKey), 'self stays in the online set while peers churn')
})

// REGRESSION (FIX-EDA-6): a member RECONNECTING (already a persisted, unchanged member) must
// re-emit event:members-updated so the renderer roster/online views re-derive. On reconnect
// persistHandshakeMember reports changed=false, so ONLY the unconditional arrival emit (the mirror
// of the onExpire departure emit) fires it — a changed-gated emit would strand the returning peer
// offline in useMembers/useSpaces until an unrelated refresh. The waitFor is the guard: with a
// conditional emit it times out.
test('a reconnecting member re-emits members-updated even though its record is unchanged', { timeout: 240000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const bStore = idStore(t)
  // B is relaunched against the SAME storage, so it must reuse the SAME identity KEK — a fresh KEK
  // can't unlock the encrypted identity written on the first boot.
  const bFlags = { identityKEK: kekHex(), membershipApprovalEnabled: true }
  const A = await launch(t, 'Alice', bootstrap)
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: bStore, downloads: mkTmpDir(t), flags: bFlags })
  const space = await A.request('space:create', { name: 'Reconnect' })
  const sid = space.spaceId
  const invite = await A.request('space:invite', { spaceId: sid })

  const bKey = await joinAndApprove(t, A, B, sid, invite)
  await A.until('members:online', { spaceId: sid }, (o) => o.includes(bKey), { ms: 60000 })

  // B goes offline; wait until A has fully processed the departure (its members-updated already
  // consumed) so the listener armed below can only catch the reconnect's arrival emit.
  B.kill()
  await A.until('members:online', { spaceId: sid }, (o) => !o.includes(bKey), { ms: 90000 })

  const arrival = A.waitFor('event:members-updated', (m) => m.spaceId === sid, 120000)
  await launchPeer(t, { bootstrap, displayName: 'Bob', storage: bStore, downloads: mkTmpDir(t), flags: bFlags })
  await arrival   // fails (times out) if the handshake emit is gated on a changed record
  t.pass('reconnect re-emitted members-updated despite an unchanged member record')

  await A.until('members:online', { spaceId: sid }, (o) => o.includes(bKey), { ms: 90000 })
  t.ok((await A.request('members:online', { spaceId: sid })).includes(bKey), 'A sees the reconnected member online again')
})
