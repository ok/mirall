import test from 'brittle'
import b4a from 'b4a'
import fs from 'bare-fs'
import path from 'bare-path'
import { openStore, getStore, setMasterSecret } from '../../src/shared/core/store.js'
import { setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { initSpaceKeys } from '../../src/shared/spaces/space-keys.js'
import { initProfile, setProfile, markOwnMembership, markApproval, readProfileRecord } from '../../src/shared/spaces/profile.js'
import { initSpaces, getSpace, upsertMember } from '../../src/shared/spaces/space.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { listJoinRequests, listPendingRequests, recordJoinRequest, setDerivedRequests } from '../../src/shared/spaces/join-requests.js'
import { configureMemberRegistry, openMemberView, closeAllMemberViews, settleRequest, unsettleRequest, isApprovedJoiner } from '../../src/shared/spaces/member-registry.js'
import { knockSettledByRecords } from '../../src/shared/spaces/knock-policy.js'
import { makePeer, replicate, waitFor } from '../helpers/peer-bee.js'
import { tmpDir } from '../helpers/bare-tmp.js'

async function boot(t, label) {
  const root = tmpDir(`mir-${label}`)
  const storage = path.join(root, 'app-storage')
  t.teardown(async () => {
    closeAllMemberViews()
    try { await getStore().close() } catch {}
    try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  })
  setRuntimeConfig({ storage, peerReadTimeoutMs: 3000 })
  await openStore(storage)
  setMasterSecret(b4a.from('44'.repeat(32), 'hex'))
  await initSpaceKeys()
  await initProfile()
  await setProfile({ displayName: 'Alice', avatar: null })
  await initSpaces()
}

const passiveDeps = (over = {}) => ({
  metaFor: () => null,
  isConnected: () => false,
  profileFor: async () => null,
  readmitConnected: () => {},
  emitMembersUpdated: () => {},
  emitJoinRequest: () => {},
  emitJoinRequestsUpdated: () => {},
  ...over,
})

const C = 'c'.repeat(64)

test('REGRESSION (co-member request): derive a pending request from a member receipt, no live requester', async (t) => {
  await boot(t, 'pending')
  const space = await createSpace('Approval Test')
  const S = space.spaceId
  await markOwnMembership(S)

  const M = await makePeer(t)
  await M.bee.put('member/' + S, { active: true, ts: 1 })
  await M.bee.put('request/' + S + '/' + C, { displayName: 'Carol', avatar: 'data:image/png;base64,Q2Fyb2w=', ts: 10 })
  await markApproval(S, M.key)
  replicate(getStore(), M.store, t)

  const reqEvents = []
  configureMemberRegistry(passiveDeps({ emitJoinRequest: (_s, r) => reqEvents.push(r) }))
  await openMemberView(S)

  t.ok(await waitFor(() => listJoinRequests(S).some((r) => r.publicKey === C)), 'C derived as pending from M receipt')
  const c = listJoinRequests(S).find((r) => r.publicKey === C)
  t.is(c.displayName, 'Carol')
  t.is(c.avatar, 'data:image/png;base64,Q2Fyb2w=')
  t.ok(reqEvents.some((r) => r.publicKey === C), 'emitted member-join-request for the newly-derived request')
})

// A deny can learn from a co-member's bee that the joiner was already let in, before the fold has
// that record. Hiding the request must stay a UI matter: the knock gate, admission and the serve
// gate answer from the fold alone, or a Deny click would hand the joiner the key on its next knock.
test('REGRESSION (FIX-395E: settling a request lets the joiner\'s next knock take the key)', async (t) => {
  await boot(t, 'settled')
  const space = await createSpace('Approval Test')
  const S = space.spaceId
  await markOwnMembership(S)

  const M = await makePeer(t)
  await M.bee.put('member/' + S, { active: true, ts: 1 })
  await M.bee.put('request/' + S + '/' + C, { displayName: 'Carol', ts: 10 })
  await markApproval(S, M.key)
  replicate(getStore(), M.store, t)

  const reqEvents = []
  configureMemberRegistry(passiveDeps({ emitJoinRequest: (_s, r) => reqEvents.push(r) }))
  await openMemberView(S)
  t.ok(await waitFor(() => listJoinRequests(S).some((r) => r.publicKey === C)), 'C derived as pending')
  const raised = reqEvents.length

  settleRequest(S, C)
  t.absent(listJoinRequests(S).some((r) => r.publicKey === C), 'the request leaves the banner at once')
  t.absent(isApprovedJoiner(S, C), 'no approval without a folded record')
  const verdict = knockSettledByRecords({ selfPending: false, isMember: false, hadLeft: false, isApproved: isApprovedJoiner(S, C) })
  t.is(verdict, null, 'C\'s next knock goes to review, never to a re-grant')

  // An unrelated request changes the folded view, so the next fold is published.
  const D = 'd'.repeat(64)
  await M.bee.put('request/' + S + '/' + D, { displayName: 'Dave', ts: 20 })
  t.ok(await waitFor(() => listJoinRequests(S).some((r) => r.publicKey === D)), 'the next fold has run')
  t.absent(listJoinRequests(S).some((r) => r.publicKey === C), 'a fold without the record does not bring it back')
  t.absent(reqEvents.slice(raised).some((r) => r.publicKey === C), 'no second join-request is raised for C')
  t.absent(isApprovedJoiner(S, C), 'the fold still grants nothing')

  unsettleRequest(S, C)
  t.ok(listJoinRequests(S).some((r) => r.publicKey === C), 'a fresh knock surfaces the request for review')
})

test('a member dismissal tombstone (ts >= receipt) withdraws the request; a fresh re-knock resurfaces', async (t) => {
  await boot(t, 'deny')
  const space = await createSpace('Approval Test')
  const S = space.spaceId
  await markOwnMembership(S)

  const M = await makePeer(t)
  await M.bee.put('member/' + S, { active: true, ts: 1 })
  await M.bee.put('request/' + S + '/' + C, { displayName: 'Carol', ts: 10 })
  await M.bee.put('denied/' + S + '/' + C, { ts: 11 })
  await markApproval(S, M.key)
  replicate(getStore(), M.store, t)

  configureMemberRegistry(passiveDeps())
  await openMemberView(S)
  t.ok(await waitFor(() => listJoinRequests(S).length === 0), 'suppressed while denial ts >= receipt ts')

  await M.bee.put('request/' + S + '/' + C, { displayName: 'Carol', ts: 20 })
  t.ok(await waitFor(() => listJoinRequests(S).some((r) => r.publicKey === C)), 're-knock resurfaces (LWW)')
})

test('an approved joiner is not shown as pending even before its own membership record replicates', async (t) => {
  await boot(t, 'approved')
  const space = await createSpace('Approval Test')
  const S = space.spaceId
  await markOwnMembership(S)

  const M = await makePeer(t)
  await M.bee.put('member/' + S, { active: true, ts: 1 })
  await M.bee.put('request/' + S + '/' + C, { displayName: 'Carol', ts: 10 })
  await markApproval(S, M.key)
  await markApproval(S, C)
  replicate(getStore(), M.store, t)

  configureMemberRegistry(passiveDeps())
  await openMemberView(S)
  await waitFor(() => false, 300)
  t.absent(listJoinRequests(S).some((r) => r.publicKey === C), 'approved joiner excluded from pending')
})

test('REGRESSION (member-also-pending): an already-joined member is never shown stuck as a pending approval', async (t) => {
  await boot(t, 'memberfilter')
  const space = await createSpace('Approval Test')
  const S = space.spaceId

  // A no-drive joiner admitted into the roster that STILL has a stale derived request (its
  // approved/<S> record hasn't yet superseded its request/<S> receipt in the fold) — member AND
  // pending. (The handshake-gate driveKey variant is excluded by listJoinRequests itself; see
  // join-request-store.test. Here we cover the member-filter layer for a no-driveKey entry.)
  recordJoinRequest(S, C, 'Carol', null, null)
  setDerivedRequests(S, new Map([[C, { displayName: 'Carol', avatar: null, ts: 1 }]]))
  await upsertMember(S, { publicKey: C, displayName: 'Carol' })

  t.ok(listJoinRequests(S).some((r) => r.publicKey === C), 'raw list still has the stale entry (caches lag)')
  const memberKeys = new Set([C])
  t.absent(listPendingRequests(S, memberKeys).some((r) => r.publicKey === C), 'filtered read excludes the member')
})

test('listPendingRequests returns genuine pending (non-members) unchanged', async (t) => {
  await boot(t, 'genuine')
  const space = await createSpace('Approval Test')
  const S = space.spaceId
  recordJoinRequest(S, C, 'Carol', null, null)
  t.ok(listPendingRequests(S, new Set()).some((r) => r.publicKey === C), 'a non-member request is still shown')
  t.ok(listPendingRequests(S, new Set(['x'.repeat(64)])).some((r) => r.publicKey === C), 'unrelated member keys do not drop it')
})

test('owner derives a co-member-approved joiner from replicated records once its bee is reachable', async (t) => {
  await boot(t, 'ownerconv')
  const space = await createSpace('Approval Test')
  const S = space.spaceId
  await markOwnMembership(S)

  // Co-member B (approved by A=creator) whose bee approves C. Joiner C's own bee carries its active
  // membership record but is NOT reachable to A yet.
  const B = await makePeer(t)
  const Cpeer = await makePeer(t)
  await B.bee.put('member/' + S, { active: true, ts: 1 })
  await B.bee.put('approved/' + S + '/' + Cpeer.key, { ts: 2 })
  await markApproval(S, B.key)
  await Cpeer.bee.put('member/' + S, { active: true, ts: 3 })
  await Cpeer.bee.put('displayName', 'Carol')

  replicate(getStore(), B.store, t)   // A <-> B only; C's bee not reachable yet

  configureMemberRegistry(passiveDeps({ profileFor: (_s, k) => readProfileRecord(k) }))
  await openMemberView(S)

  const memberKeys = async () => new Set(((await getSpace(S)).members || []).map((m) => m.publicKey))
  t.ok(await waitFor(async () => (await memberKeys()).has(B.key), 6000), 'B derived as a member')
  t.absent((await memberKeys()).has(Cpeer.key), 'C not derived yet — its bee is unreachable')

  // C's bee becomes reachable; the view re-folds and derives C — the owner converges on a joiner approved
  // by a co-member, which is the symptom end-state. (The active follow additionally hardens the eventual,
  // transitive-via-a-co-member case, verified at the flow layer.)
  replicate(getStore(), Cpeer.store, t)
  t.ok(await waitFor(async () => (await memberKeys()).has(Cpeer.key), 10000), 'A converges on C once its bee replicates')
  const c = (await getSpace(S)).members.find((m) => m.publicKey === Cpeer.key)
  t.is(c.displayName, 'Carol', 'C identity hydrated from the now-replicated bee')
})
