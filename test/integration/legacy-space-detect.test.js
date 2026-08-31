import test from 'brittle'
import { freshPeer, freshDurable } from '../helpers/store.js'
import { createSpace, getSpace, mutateSpace, listSpaces, isLegacySpace } from '../../src/shared/spaces/space.js'
import { ownCatalog, catalogNameFor, purgeOwnCatalog, legacyPlaintextCatalogName, dropCatalog } from '../../src/shared/shares/share-catalog.js'
import { createBee, getStore } from '../../src/shared/core/store.js'
import b4a from 'b4a'

// Spaces created before v1.7.0 carry no schemaVersion, hold no SCK, and cannot be upgraded —
// v2 needs the creator to mint a key and re-grant every member. Nothing can create one any more,
// so the surviving guard is what keeps such a record from half-working: the catalog name, the
// own-catalog open and the admit gate all now assume an encrypted space.

test('a record without schemaVersion 2 is classified legacy', async (t) => {
  await freshPeer(t)
  const space = await createSpace('Current')
  t.absent(isLegacySpace(await getSpace(space.spaceId)), 'a freshly created space is not legacy')

  // The only way left to produce the pre-v1.7.0 shape: write it directly.
  await mutateSpace(space.spaceId, (s) => { const next = { ...s }; delete next.schemaVersion; return next })
  t.ok(isLegacySpace(await getSpace(space.spaceId)), 'a record with no schemaVersion is legacy')

  t.is((await listSpaces()).filter(isLegacySpace).length, 1, 'boot detection surfaces exactly this one')
})

test('isLegacySpace is false for a missing record', (t) => {
  t.absent(isLegacySpace(null), 'no record is not a legacy space')
  t.absent(isLegacySpace(undefined), 'undefined is not a legacy space')
})

// A keyless boot stays legal — only creating or joining a space needs an identity. The store's
// name-derived core paths (createBee / localBeeCore / createDrive) are reached no other way.
test('the data layer still boots with no identity, but cannot create a space', async (t) => {
  await freshDurable(t)
  t.alike(await listSpaces(), [], 'the spaces bee opened and is empty')

  await t.exception(() => createSpace('Nope'), /identity is required/, 'no identity, no space')
})

// Make the pre-v1.7.0 shape: strip schemaVersion so the record can never resolve an SCK.
async function legacySpace (name) {
  const space = await createSpace(name)
  await mutateSpace(space.spaceId, (s) => { const next = { ...s }; delete next.schemaVersion; return next })
  // createSpace opened (and cached) the catalog while the record was still v2. A real legacy
  // space is reached from a cold boot, where nothing has cached one — drop it to match.
  dropCatalog(space.spaceId)
  return space.spaceId
}

test('opening a legacy space catalog fails with SPACE_UNSUPPORTED, not a bare error', async (t) => {
  await freshPeer(t)
  const spaceId = await legacySpace('Ancient')
  await t.exception(() => ownCatalog(spaceId), /older version/, 'refused with the legacy message')
  const err = await ownCatalog(spaceId).then(() => null, (e) => e)
  t.is(err.code, 'SPACE_UNSUPPORTED', 'carries a code the renderer can act on')
})

// The leave path resolves the "-e1" name for every space, so without an explicit legacy purge a
// pre-encryption catalog — full file metadata, readable with no key — outlives the leave.
test('leaving a legacy space purges its plaintext catalog core', async (t) => {
  await freshPeer(t)
  const spaceId = await legacySpace('Ancient')
  const rec = await getSpace(spaceId)

  const plainName = await legacyPlaintextCatalogName(spaceId)
  t.absent(plainName.endsWith('-e1'), 'precondition: the legacy core carries no suffix')
  t.ok((await catalogNameFor(spaceId)).endsWith('-e1'), 'precondition: the resolver still returns -e1')

  const plain = createBee(plainName)
  await plain.put('file/__loose__/secret.txt', { size: 1, mtime: 1, contentHash: null })
  const dk = b4a.toString(plain.core.discoveryKey, 'hex')
  await plain.close()

  const present = async () => {
    for await (const d of getStore().list()) if (b4a.toString(d, 'hex') === dk) return true
    return false
  }
  t.ok(await present(), 'precondition: the plaintext catalog is on disk')

  await purgeOwnCatalog(spaceId, rec)
  t.absent(await present(), 'the plaintext catalog is purged with the space')
})
