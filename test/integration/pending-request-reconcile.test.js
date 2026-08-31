import test from 'brittle'
import b4a from 'b4a'
import os from 'bare-os'
import fs from 'bare-fs'
import path from 'bare-path'
import { initStore, getStore, setMasterSecret } from '../../src/shared/core/store.js'
import { setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { initSpaceKeys } from '../../src/shared/spaces/space-keys.js'
import { initProfile, setProfile, markOwnMembership, markApproval, readProfileRecord } from '../../src/shared/spaces/profile.js'
import { initSpaces, createSpace, getSpace, listJoinRequests, listPendingRequests, recordJoinRequest, setDerivedRequests, upsertMember } from '../../src/shared/spaces/space.js'
import { configureMemberRegistry, openMemberView, closeAllMemberViews } from '../../src/shared/spaces/member-registry.js'
import { makePeer, replicate, waitFor } from '../helpers/peer-bee.js'

function tmp (label) {
  const dir = path.join(os.tmpdir(), `mir-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function boot (t, label) {
  const root = tmp(label)
  const storage = path.join(root, 'app-storage')
  t.teardown(async () => {
    closeAllMemberViews()
    try { await getStore().close() } catch {}
    try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  })
  setRuntimeConfig({ storage, peerReadTimeoutMs: 3000 })
  initStore(storage)
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

test('REGRESSION (member-also-pending): listPendingRequests excludes roster members', async (t) => {
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
