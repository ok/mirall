import test from 'brittle'
import b4a from 'b4a'
import fs from 'bare-fs'
import path from 'bare-path'
import { openStore, getStore, setMasterSecret } from '../../src/shared/core/store.js'
import { setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
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
