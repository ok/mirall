import test from 'brittle'
import b4a from 'b4a'
import fs from 'bare-fs'
import path from 'bare-path'
import { openStore, getStore, setMasterSecret } from '../../src/shared/core/store.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { initSpaceKeys } from '../../src/shared/spaces/space-keys.js'
import {
  initProfile, setProfile,
  markOwnMembership, markApproval, readProfileRecord,
} from '../../src/shared/spaces/profile.js'
import { initSpaces, getSpace, mutateMembers, _spacesBeeForTests } from '../../src/shared/spaces/space.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { configureMemberRegistry, openMemberView, closeAllMemberViews } from '../../src/shared/spaces/member-registry.js'
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

test('REGRESSION (Unknown member): derived member shows bee name+avatar with NO live handshake', async (t) => {
  await boot(t, 'unknown')
  const space = await createSpace('Approval Test')
  const S = space.spaceId
  await markOwnMembership(S)

  const B = await makePeer(t)
  await B.bee.put('displayName', 'Steve')
  await B.bee.put('avatar', 'data:image/png;base64,STEVE')
  await B.bee.put('member/' + S, { active: true, ts: 1 })
  await markApproval(S, B.key)
  replicate(getStore(), B.store, t)

  configureMemberRegistry({
    metaFor: () => null,
    isConnected: () => false,
    profileFor: (_s, k) => readProfileRecord(k),
    readmitConnected: () => {},
    emitMembersUpdated: () => {},
  })
  await openMemberView(S)

  const memberOf = async () => (await getSpace(S)).members?.find((m) => m.publicKey === B.key)
  t.ok(await waitFor(async () => (await memberOf())?.displayName === 'Steve'), 'name from replicated bee')
  t.is((await memberOf()).avatar, 'data:image/png;base64,STEVE', 'avatar from replicated bee')
})

test('REGRESSION (missing avatar): connected member with no handshake avatar gets it from the bee', async (t) => {
  await boot(t, 'avatar')
  const space = await createSpace('Approval Test')
  const S = space.spaceId
  await markOwnMembership(S)

  const B = await makePeer(t)
  await B.bee.put('displayName', 'Steve')
  await B.bee.put('avatar', 'data:image/png;base64,STEVE')
  await B.bee.put('member/' + S, { active: true, ts: 1 })
  await markApproval(S, B.key)
  replicate(getStore(), B.store, t)

  const meta = { displayName: 'Steve', avatar: null }
  configureMemberRegistry({
    metaFor: (_s, k) => (k === B.key ? meta : null),
    isConnected: (_s, k) => k === B.key,
    profileFor: (_s, k) => readProfileRecord(k),
    readmitConnected: () => {},
    emitMembersUpdated: () => {},
  })
  await openMemberView(S)

  const memberOf = async () => (await getSpace(S)).members?.find((m) => m.publicKey === B.key)
  t.ok(await waitFor(async () => (await memberOf())?.avatar === 'data:image/png;base64,STEVE'), 'avatar backfilled from bee')
  t.is((await memberOf()).displayName, 'Steve', 'name still from live meta')
})

// A co-member whose profile publishes an encrypted loose-catalog key: its epoch reads as 0, and the
// reconcile writes it onto the member once. `reconciles` counts finished passes — readmitConnected
// runs after the write whenever the member is not connected.
async function settledCoMember(t, label) {
  await boot(t, label)
  const { spaceId: S } = await createSpace('Fixed point')
  await markOwnMembership(S)
  const B = await makePeer(t)
  await B.bee.put('displayName', 'Steve')
  await B.bee.put('member/' + S, { active: true, ts: 1 })
  await B.bee.put('loosecatEnc/' + S, 'ab'.repeat(40))
  await markApproval(S, B.key)
  replicate(getStore(), B.store, t)

  const counter = { reconciles: 0 }
  configureMemberRegistry({
    metaFor: () => null,
    isConnected: () => false,
    profileFor: (_s, k) => readProfileRecord(k, S),
    readmitConnected: () => { counter.reconciles++ },
    emitMembersUpdated: () => {},
  })
  await openMemberView(S)
  const memberOf = async () => (await getSpace(S)).members?.find((m) => m.publicKey === B.key)
  t.ok(await waitFor(async () => (await memberOf())?.looseCatalogEpoch === 0), 'settled with the epoch')
  return { S, B, counter, memberOf }
}

// Reopens the view as a boot does and resolves once its reconcile has finished and written.
async function reopenAndSettle(S, counter) {
  const seen = counter.reconciles
  await closeAllMemberViews()
  await openMemberView(S)
  const reconciled = await waitFor(() => counter.reconciles > seen)
  await mutateMembers(S, () => null)
  return reconciled
}

test('reopening a member view over a settled roster writes nothing', async (t) => {
  const { S, counter } = await settledCoMember(t, 'fixed-point')
  const length = _spacesBeeForTests().core.length
  t.ok(await reopenAndSettle(S, counter), 'the reopened view reconciled')
  t.is(_spacesBeeForTests().core.length, length, 'a settled roster is rewritten by nobody')
})

test('a member in the v1.11.0 shape is rewritten once, then left alone', async (t) => {
  const { S, B, counter, memberOf } = await settledCoMember(t, 'older-shape')
  await mutateMembers(S, () => [{
    publicKey: B.key, driveKey: 'cd'.repeat(32), displayName: 'Steve', avatar: null, looseCatalogKey: null, looseCatalogKeyEnc: 'ab'.repeat(40),
  }])
  const bee = _spacesBeeForTests()

  const before = bee.core.length
  t.ok(await reopenAndSettle(S, counter), 'the reopened view reconciled')
  t.is(bee.core.length, before + 1, 'one rewrite converts the older shape')
  const member = await memberOf()
  t.absent('driveKey' in member, 'without the participation id')
  t.is(member.looseCatalogEpoch, 0, 'with the epoch')

  const after = bee.core.length
  t.ok(await reopenAndSettle(S, counter), 'reconciled again')
  t.is(bee.core.length, after, 'and then nothing more')
})

// The inviter a bearer invite names sits on the roster flagged unverified. The fold never considers
// it, so "mere absence never removes" would keep it forever; a settled fold (nothing unread, self
// reached) is the positive evidence that decides it: held → verified, not held → dropped.
function reconcileRig(counter = { readmits: 0 }) {
  configureMemberRegistry({
    metaFor: () => null,
    isConnected: () => false,
    profileFor: (_s, k) => readProfileRecord(k),
    readmitConnected: () => { counter.readmits++ },
    emitMembersUpdated: () => {},
  })
  return counter
}

const seed = (S, entry) => mutateMembers(S, (members) => [...members, { avatar: null, unverified: true, ...entry }])
const rosterOf = async (S) => (await getSpace(S)).members || []

test('REGRESSION (MIR-44: reconcile kept an unconfirmed invite seed forever)', async (t) => {
  await boot(t, 'seed-drop')
  const { spaceId: S } = await createSpace('Seeded')
  await markOwnMembership(S)
  const M = 'd'.repeat(64)
  await seed(S, { publicKey: M, displayName: 'Mallory' })
  reconcileRig()
  await openMemberView(S)

  const gone = await waitFor(async () => !(await rosterOf(S)).some((m) => m.publicKey === M))
  t.comment('observed roster: ' + JSON.stringify((await rosterOf(S)).map((m) => [m.displayName, !!m.unverified])))
  t.ok(gone, 'a settled fold that does not hold the seed drops it')
})

test('REGRESSION (MIR-44: the fold holding an invite seed left it unverified)', async (t) => {
  await boot(t, 'seed-verify')
  const { spaceId: S } = await createSpace('Seeded')
  await markOwnMembership(S)
  const B = await makePeer(t)
  await B.bee.put('displayName', 'Steve')
  await B.bee.put('member/' + S, { active: true, ts: 1 })
  await markApproval(S, B.key)
  await seed(S, { publicKey: B.key, displayName: 'Steve' })
  replicate(getStore(), B.store, t)
  reconcileRig()
  await openMemberView(S)

  const verified = await waitFor(async () => (await rosterOf(S)).some((m) => m.publicKey === B.key && !m.unverified))
  t.comment('observed roster: ' + JSON.stringify((await rosterOf(S)).map((m) => [m.displayName, !!m.unverified])))
  t.ok(verified, 'the fold vouches for the key, so the flag clears')
  t.is((await rosterOf(S)).filter((m) => m.publicKey === B.key).length, 1, 'and the entry is not duplicated')
})

test('a fold with an unread key keeps the invite seed', async (t) => {
  await boot(t, 'seed-unsettled')
  // absolute: the unread key's read budget is the window the fold spends before it reports.
  setRuntimeConfig({ ...getRuntimeConfig(), peerReadTimeoutMs: 300 })
  const { spaceId: S } = await createSpace('Seeded')
  await markOwnMembership(S)
  const B = await makePeer(t)
  await B.bee.put('member/' + S, { active: true, ts: 1 })
  await markApproval(S, B.key)
  await markApproval(S, 'e'.repeat(64))
  replicate(getStore(), B.store, t)
  const M = 'd'.repeat(64)
  await seed(S, { publicKey: M, displayName: 'Mallory' })
  const counter = reconcileRig()
  await openMemberView(S)

  t.ok(await waitFor(() => counter.readmits > 0), 'a fold reconciled (the readable co-member was readmitted)')
  const held = (await rosterOf(S)).find((m) => m.publicKey === M)
  t.ok(held?.unverified, 'the seed is still held, still unverified, while a key is unread')
})
