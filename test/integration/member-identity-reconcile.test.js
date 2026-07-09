import test from 'brittle'
import b4a from 'b4a'
import os from 'bare-os'
import fs from 'bare-fs'
import path from 'bare-path'
import { initStore, getStore, setMasterSecret } from '../../src/shared/core/store.js'
import { setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { initSpaceKeys } from '../../src/shared/spaces/space-keys.js'
import {
  initProfile, setProfile,
  markOwnMembership, markApproval, readProfileRecord,
} from '../../src/shared/spaces/profile.js'
import { initSpaces, createSpace, getSpace } from '../../src/shared/spaces/space.js'
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
  setRuntimeConfig({ storage, membershipApprovalEnabled: true, peerReadTimeoutMs: 3000 })
  initStore(storage)
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

  const meta = { displayName: 'Steve', avatar: null, driveKey: 'd'.repeat(64) }
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

test('REGRESSION (no files): derived member gets its driveKey from the replicated bee (no handshake)', async (t) => {
  await boot(t, 'drivekey')
  const space = await createSpace('Approval Test')
  const S = space.spaceId
  await markOwnMembership(S)

  // A member we derive purely from records (no live handshake/meta) that published its per-space
  // drive key in its bee. Without hydrating driveKey from the bee, the member shows driveKey=null
  // and its drive (and therefore its files) can never be opened by us.
  const driveKeyHex = 'a'.repeat(64)
  const B = await makePeer(t)
  await B.bee.put('displayName', 'Steve')
  await B.bee.put('member/' + S, { active: true, ts: 1 })
  await B.bee.put('drive/' + S, driveKeyHex)
  await markApproval(S, B.key)
  replicate(getStore(), B.store, t)

  configureMemberRegistry({
    metaFor: () => null,                       // no live handshake → driveKey can only come from the bee
    isConnected: () => false,
    profileFor: (s, k) => readProfileRecord(k, s),
    readmitConnected: () => {},
    emitMembersUpdated: () => {},
  })
  await openMemberView(S)

  const memberOf = async () => (await getSpace(S)).members?.find((m) => m.publicKey === B.key)
  t.ok(await waitFor(async () => (await memberOf())?.driveKey === driveKeyHex), 'driveKey hydrated from the replicated bee')
})
