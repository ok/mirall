import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import os from 'bare-os'
import fs from 'bare-fs'
import path from 'bare-path'
import { initStore, getStore, setMasterSecret } from '../../src/shared/core/store.js'
import { setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { initSpaceKeys } from '../../src/shared/spaces/space-keys.js'
import { initProfile, setProfile, getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import {
  initSpaces, createSpace, joinSpace, getSpace, mutateSpace,
  backfillSelfCreatedCreatorKey, pinCreatorKey, flagUnverifiedJoinedCreators,
  markCreatorDivergence, clearCreatorDivergence,
} from '../../src/shared/spaces/space.js'

// The membership fold (phase a) folds an OR-Set whose only base case is the space
// CREATOR — the one member with no approval record. So the creator key must be a
// durable, agreed fact: stamped at creation, carried in invites, and seeded by every
// peer. These tests lock the data plumbing (the fold itself is tested in later steps).

function tmp (label) {
  const dir = path.join(os.tmpdir(), `ckey-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function boot (t, label, { membershipApprovalEnabled = true } = {}) {
  const root = tmp(label)
  const storage = path.join(root, 'app-storage')
  t.teardown(async () => {
    try { await getStore().close() } catch {}
    try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  })
  setRuntimeConfig({ storage, membershipApprovalEnabled })
  initStore(storage)
  setMasterSecret(b4a.from('44'.repeat(32), 'hex'))
  await initSpaceKeys()
  await initProfile()
  await setProfile({ displayName: 'Alice', avatar: null })
  await initSpaces()
}

test('createSpace stamps creatorKey = self on a v2 space', async (t) => {
  await boot(t, 'create-v2')
  const space = await createSpace('Secret')
  t.is(space.schemaVersion, 2, 'v2 space')
  t.is(space.creatorKey, getLocalPublicKeyHex(), 'creator is self')
  t.is((await getSpace(space.spaceId)).creatorKey, getLocalPublicKeyHex(), 'persisted')
})

test('a v1 space carries no creatorKey (no membership fold)', async (t) => {
  await boot(t, 'create-v1', { membershipApprovalEnabled: false })
  const space = await createSpace('Plain')
  t.absent(space.schemaVersion, 'v1 space')
  t.absent(space.creatorKey, 'no creatorKey on v1')
})

test('joinSpace stores the creator carried by the invite', async (t) => {
  await boot(t, 'join')
  const topic = b4a.toString(crypto.randomBytes(32), 'hex')
  const creator = b4a.toString(crypto.randomBytes(32), 'hex')
  const joined = await joinSpace(topic, 'Joined', 'folder', { schemaVersion: 2, creator })
  t.is(joined.pending, true, 'v2 join is pending')
  t.is((await getSpace(joined.spaceId)).creatorKey, creator, 'creator stored from invite')
})

test('joinSpace without a creator (legacy invite) leaves creatorKey absent', async (t) => {
  await boot(t, 'join-legacy')
  const topic = b4a.toString(crypto.randomBytes(32), 'hex')
  const joined = await joinSpace(topic, 'Joined', 'folder', { schemaVersion: 2 })
  t.absent((await getSpace(joined.spaceId)).creatorKey, 'no creator carried, none stored')
})

test('backfill stamps a self-created space missing creatorKey, idempotently', async (t) => {
  await boot(t, 'backfill-own')
  const space = await createSpace('Secret')
  // Simulate a space created before creatorKey existed: strip the field, keep sckDerivable.
  await mutateSpace(space.spaceId, (s) => { delete s.creatorKey; return s })
  const stripped = await getSpace(space.spaceId)
  t.absent(stripped.creatorKey, 'pre-migration: no creatorKey')
  t.ok(stripped.sckDerivable, 'but sckDerivable marks it self-created')

  t.is(await backfillSelfCreatedCreatorKey(), 1, 'one space stamped')
  t.is((await getSpace(space.spaceId)).creatorKey, getLocalPublicKeyHex(), 'creator backfilled to self')
  t.is(await backfillSelfCreatedCreatorKey(), 0, 'idempotent — nothing left to stamp')
})

test('backfill leaves joined spaces (no sckDerivable) untouched', async (t) => {
  await boot(t, 'backfill-joined')
  const topic = b4a.toString(crypto.randomBytes(32), 'hex')
  const joined = await joinSpace(topic, 'Joined', 'folder', { schemaVersion: 2 })
  t.absent((await getSpace(joined.spaceId)).sckDerivable, 'joined space is not self-created')

  t.is(await backfillSelfCreatedCreatorKey(), 0, 'no self-created space to stamp')
  t.absent((await getSpace(joined.spaceId)).creatorKey, 'joined space left for the fold fallback')
})

// MIR-26: the invite's creator is an unauthenticated bearer hint, so a join must store it
// PROVISIONAL — the authenticated grant (or handshake) is what pins it for real.

test('REGRESSION (MIR-26: invite creator is stored provisional)', async (t) => {
  await boot(t, 'join-provisional')
  const topic = b4a.toString(crypto.randomBytes(32), 'hex')
  const creator = b4a.toString(crypto.randomBytes(32), 'hex')
  const joined = await joinSpace(topic, 'Joined', 'folder', { schemaVersion: 2, creator })
  const space = await getSpace(joined.spaceId)
  t.is(space.creatorKey, creator, 'creator pre-seeded from invite')
  t.is(space.creatorUnverified, true, 'but marked provisional until an authenticated grant')
})

test('createSpace stamps an authoritative (non-provisional) creatorKey', async (t) => {
  await boot(t, 'create-authoritative')
  const space = await createSpace('Secret')
  t.is((await getSpace(space.spaceId)).creatorKey, getLocalPublicKeyHex(), 'self is the root')
  t.absent((await getSpace(space.spaceId)).creatorUnverified, 'self-created is never provisional')
})

test('pinCreatorKey sets the root and clears the provisional flag', async (t) => {
  await boot(t, 'pin-creator')
  const topic = b4a.toString(crypto.randomBytes(32), 'hex')
  const hint = b4a.toString(crypto.randomBytes(32), 'hex')
  const real = b4a.toString(crypto.randomBytes(32), 'hex')
  const joined = await joinSpace(topic, 'Joined', 'folder', { schemaVersion: 2, creator: hint })
  t.is((await getSpace(joined.spaceId)).creatorUnverified, true, 'starts provisional')

  await pinCreatorKey(joined.spaceId, real)
  const space = await getSpace(joined.spaceId)
  t.is(space.creatorKey, real, 'creatorKey corrected to the authenticated root')
  t.is(space.creatorUnverified, false, 'flag cleared')
})

test('flagUnverifiedJoinedCreators flags TOFU-pinned joined spaces, leaves the rest', async (t) => {
  await boot(t, 'migration')
  // A self-created space — authoritative, must stay untouched.
  const own = await createSpace('Mine')
  // A pre-MIR-26 joined space: creatorKey pinned, but no creatorUnverified flag yet.
  const topic = b4a.toString(crypto.randomBytes(32), 'hex')
  const creator = b4a.toString(crypto.randomBytes(32), 'hex')
  const joined = await joinSpace(topic, 'Joined', 'folder', { schemaVersion: 2, creator })
  await mutateSpace(joined.spaceId, (s) => { delete s.creatorUnverified; return s })
  t.absent((await getSpace(joined.spaceId)).creatorUnverified, 'pre-migration: no flag')

  t.is(await flagUnverifiedJoinedCreators(), 1, 'one joined space flagged')
  t.is((await getSpace(joined.spaceId)).creatorUnverified, true, 'joined space now provisional')
  t.absent((await getSpace(own.spaceId)).creatorUnverified, 'self-created left authoritative')

  t.is(await flagUnverifiedJoinedCreators(), 0, 'idempotent — nothing left to flag')
})

// REGRESSION (FIX-EDA-9: creatorDivergence had no clearing transition — once a refuse set it,
// no reconcile outcome ever wrote it back to false, so the security banner was permanent for
// self-created spaces and honest re-convergence went unrecognized).
test('REGRESSION (FIX-EDA-9): divergence marks, clears on re-convergence, and clears on re-pin', async (t) => {
  await boot(t, 'divergence-clear')
  const topic = b4a.toString(crypto.randomBytes(32), 'hex')
  const real = b4a.toString(crypto.randomBytes(32), 'hex')
  const joined = await joinSpace(topic, 'Joined', 'folder', { schemaVersion: 2, creator: real })
  await pinCreatorKey(joined.spaceId, real)

  await markCreatorDivergence(joined.spaceId)
  let space = await getSpace(joined.spaceId)
  t.is(space.creatorDivergence, true, 'refuse persists the divergence flag')
  t.is(space.creatorKey, real, 'the pin is left untouched')

  await clearCreatorDivergence(joined.spaceId)
  t.is((await getSpace(joined.spaceId)).creatorDivergence, false, 'an authenticated noop re-assert clears it')

  await clearCreatorDivergence(joined.spaceId)
  t.is((await getSpace(joined.spaceId)).creatorDivergence, false, 'clearing an already-clear flag is a no-op')

  await markCreatorDivergence(joined.spaceId)
  await pinCreatorKey(joined.spaceId, real)
  t.is((await getSpace(joined.spaceId)).creatorDivergence, false, 'pinCreatorKey also clears it')
})

// REGRESSION (FIX-EDA-17: the MIR-26 migration ran on EVERY boot with no marker, downgrading an
// authenticated pin back to provisional — which re-opened the adopt path to a divergent root
// after any restart).
test('REGRESSION (FIX-EDA-17): the migration is one-shot — an authenticated pin survives later boots', async (t) => {
  await boot(t, 'migration-oneshot')
  const topic = b4a.toString(crypto.randomBytes(32), 'hex')
  const creator = b4a.toString(crypto.randomBytes(32), 'hex')
  const joined = await joinSpace(topic, 'Joined', 'folder', { schemaVersion: 2, creator })
  await mutateSpace(joined.spaceId, (s) => { delete s.creatorUnverified; return s })

  t.is(await flagUnverifiedJoinedCreators(), 1, 'first boot: pre-MIR-26 pin flagged provisional')

  await pinCreatorKey(joined.spaceId, creator)
  t.is((await getSpace(joined.spaceId)).creatorUnverified, false, 'handshake re-authentication pins the root')

  t.is(await flagUnverifiedJoinedCreators(), 0, 'next boot: nothing re-flagged')
  const space = await getSpace(joined.spaceId)
  t.is(space.creatorUnverified, false, 'the authenticated pin is NOT downgraded to provisional')
  t.is(space.creatorMigrated, true, 'the space is stamped past the migration')
})

test('the migration stamps already-provisional joined spaces without re-flagging them later', async (t) => {
  await boot(t, 'migration-stamp')
  const topic = b4a.toString(crypto.randomBytes(32), 'hex')
  const creator = b4a.toString(crypto.randomBytes(32), 'hex')
  const joined = await joinSpace(topic, 'Joined', 'folder', { schemaVersion: 2, creator })
  t.is((await getSpace(joined.spaceId)).creatorUnverified, true, 'post-MIR-26 join starts provisional')

  t.is(await flagUnverifiedJoinedCreators(), 0, 'already provisional — nothing to flag')
  t.is((await getSpace(joined.spaceId)).creatorMigrated, true, 'but the space is stamped')

  await pinCreatorKey(joined.spaceId, creator)
  t.is(await flagUnverifiedJoinedCreators(), 0, 'a later boot leaves the now-authenticated pin alone')
  t.is((await getSpace(joined.spaceId)).creatorUnverified, false)
})
