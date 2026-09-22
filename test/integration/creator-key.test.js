import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import fs from 'bare-fs'
import path from 'bare-path'
import { openStore, getStore, setMasterSecret, getStoragePath } from '../../src/shared/core/store.js'
import { deriveContentKey } from '../../src/shared/core/identity-keys.js'
import { setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { initSpaceKeys } from '../../src/shared/spaces/space-keys.js'
import { initProfile, setProfile, getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import { initSpaces, getSpace, mutateSpace, isCreatedBySelf, getSpaceContentKey, getSpaceContentKeyForEpoch } from '../../src/shared/spaces/space.js'
import { createSpace, joinSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { backfillCreatedBySelf, backfillSelfCreatedCreatorKey, pinCreatorKey, flagUnverifiedJoinedCreators, markCreatorDivergence, clearCreatorDivergence } from '../../src/shared/spaces/creator-pin.js'
import { tmpDir } from '../helpers/bare-tmp.js'

// The membership fold (phase a) folds an OR-Set whose only base case is the space
// CREATOR — the one member with no approval record. So the creator key must be a
// durable, agreed fact: stamped at creation, carried in invites, and seeded by every
// peer. These tests lock the data plumbing (the fold itself is tested in later steps).

async function boot(t, label) {
  const root = tmpDir(`ckey-${label}`)
  const storage = path.join(root, 'app-storage')
  t.teardown(async () => {
    try { await getStore().close() } catch {}
    try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  })
  setRuntimeConfig({ storage })
  await openStore(storage)
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

test('joinSpace stores the creator carried by the invite', async (t) => {
  await boot(t, 'join')
  const topic = b4a.toString(crypto.randomBytes(32), 'hex')
  const creator = b4a.toString(crypto.randomBytes(32), 'hex')
  const joined = await joinSpace(topic, 'Joined', 'folder', { creator })
  t.is(joined.pending, true, 'v2 join is pending')
  t.is((await getSpace(joined.spaceId)).creatorKey, creator, 'creator stored from invite')
})

test('joinSpace without a creator (legacy invite) leaves creatorKey absent', async (t) => {
  await boot(t, 'join-legacy')
  const topic = b4a.toString(crypto.randomBytes(32), 'hex')
  const joined = await joinSpace(topic, 'Joined', 'folder')
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
  const joined = await joinSpace(topic, 'Joined', 'folder')
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
  const joined = await joinSpace(topic, 'Joined', 'folder', { creator })
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
  const joined = await joinSpace(topic, 'Joined', 'folder', { creator: hint })
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
  const joined = await joinSpace(topic, 'Joined', 'folder', { creator })
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
  const joined = await joinSpace(topic, 'Joined', 'folder', { creator: real })
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
  const joined = await joinSpace(topic, 'Joined', 'folder', { creator })
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
  const joined = await joinSpace(topic, 'Joined', 'folder', { creator })
  t.is((await getSpace(joined.spaceId)).creatorUnverified, true, 'post-MIR-26 join starts provisional')

  t.is(await flagUnverifiedJoinedCreators(), 0, 'already provisional — nothing to flag')
  t.is((await getSpace(joined.spaceId)).creatorMigrated, true, 'but the space is stamped')

  await pinCreatorKey(joined.spaceId, creator)
  t.is(await flagUnverifiedJoinedCreators(), 0, 'a later boot leaves the now-authenticated pin alone')
  t.is((await getSpace(joined.spaceId)).creatorUnverified, false)
})

// The SCK epoch: every record is at epoch 0, the created-by-me marker is split from derivability,
// and the epoch-0 key is byte-identical to the derivation every earlier release used.

const M = b4a.from('44'.repeat(32), 'hex')

// A record as an earlier release wrote it: no epoch, no createdBySelf, only sckDerivable.
const asOlderRecord = (s) => { const { createdBySelf, epoch, ...older } = s; return older }

test('createSpace stamps epoch 0, createdBySelf and the older created-by-me marker', async (t) => {
  await boot(t, 'epoch0')
  const space = await createSpace('Secret')
  const rec = await getSpace(space.spaceId)
  t.is(rec.epoch, 0)
  t.is(rec.createdBySelf, true)
  t.is(rec.sckDerivable, true, 'the marker a downgrade reads is still written')
  t.ok(isCreatedBySelf(rec))
})

test('joinSpace stamps epoch 0 and no createdBySelf', async (t) => {
  await boot(t, 'join-epoch0')
  const topic = b4a.toString(crypto.randomBytes(32), 'hex')
  const joined = await joinSpace(topic, 'Joined', 'folder')
  const rec = await getSpace(joined.spaceId)
  t.is(rec.epoch, 0)
  t.absent(rec.createdBySelf)
  t.absent(isCreatedBySelf(rec))
})

test('isCreatedBySelf reads the older marker on a record that predates the split field', (t) => {
  t.ok(isCreatedBySelf({ sckDerivable: true }))
  t.absent(isCreatedBySelf({}))
  t.absent(isCreatedBySelf({ createdBySelf: false, sckDerivable: true }), 'the split field wins once present')
})

test('backfillCreatedBySelf stamps a record that carries only the older marker, once', async (t) => {
  await boot(t, 'backfill-self')
  const own = await createSpace('Old')
  const topic = b4a.toString(crypto.randomBytes(32), 'hex')
  const joined = await joinSpace(topic, 'Joined', 'folder')
  await mutateSpace(own.spaceId, asOlderRecord)
  await mutateSpace(joined.spaceId, asOlderRecord)
  t.absent((await getSpace(own.spaceId)).createdBySelf, 'an older record')

  t.is(await backfillCreatedBySelf(), 1, 'the created space is stamped')
  t.is((await getSpace(own.spaceId)).createdBySelf, true)
  t.absent((await getSpace(joined.spaceId)).createdBySelf, 'the joined space is left alone')
  t.is(await backfillCreatedBySelf(), 0, 'idempotent')
})

test('the creator passes read the split field: an older created space still backfills its root', async (t) => {
  await boot(t, 'passes-split')
  const own = await createSpace('Old')
  await mutateSpace(own.spaceId, (s) => { const older = asOlderRecord(s); delete older.creatorKey; return older })
  await backfillCreatedBySelf()
  t.is(await backfillSelfCreatedCreatorKey(), 1, 'rooted at self through createdBySelf')
  t.is(await flagUnverifiedJoinedCreators(), 0, 'and never flagged as a joined space')
})

test('the epoch-0 key equals the legacy derivation, with and without a vault entry', async (t) => {
  await boot(t, 'derive')
  const space = await createSpace('Secret')
  const legacy = deriveContentKey(M, 'space-content/' + space.spaceId)
  const rec = await getSpace(space.spaceId)
  t.alike(getSpaceContentKey(space.spaceId, rec), legacy, 'the vault copy')
  t.alike(getSpaceContentKeyForEpoch(space.spaceId, rec, 0), legacy)
  t.alike(getSpaceContentKey(space.spaceId, asOlderRecord(rec)), legacy, 'an older record reads the same key')

  // Lose the vault (what the derive fallback exists for) and derive again.
  fs.rmSync(path.join(path.dirname(getStoragePath()), 'space-keys.enc'))
  await initSpaceKeys()
  t.alike(getSpaceContentKey(space.spaceId, rec), legacy, 'derive fallback at epoch 0')
  t.alike(getSpaceContentKey(space.spaceId, asOlderRecord(rec)), legacy, 'and for an older record')
  t.is(getSpaceContentKeyForEpoch(space.spaceId, rec, 1), null, 'no derivation for a later epoch')
  t.is(getSpaceContentKey(space.spaceId, { ...rec, epoch: 1 }), null, 'a rotated space holds its key nowhere but the vault')
  t.is(getSpaceContentKey(space.spaceId, { ...rec, createdBySelf: false, sckDerivable: false }), null, 'a joined space never derives')
  t.is(getSpaceContentKey(space.spaceId, null), null)
})
