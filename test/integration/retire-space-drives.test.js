import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import Hyperbee from 'hyperbee'
import Hyperdrive from 'hyperdrive'
import { freshDurable } from '../helpers/store.js'
import { mutateMembers } from '../../src/shared/spaces/space.js'
import { getStore, ownParticipationId } from '../../src/shared/core/store.js'
import { deriveParticipationKeyPair } from '../../src/shared/core/identity-keys.js'
import { getSpace, getSpaceContentKey } from '../../src/shared/spaces/space.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { retireSpaceDrives } from '../../src/shared/storage/migrations/retire-space-drives.js'
import { blobsKeyFor, purgeOwnRetiredDrive } from '../../src/shared/storage/retired-drive-cores.js'

// The drive an earlier release opened for every space: its metadata core by the participation key
// pair on the root store, SCK-encrypted, with Hyperdrive creating the blobs core beside it.
async function plantOldDrive(M, space) {
  const sck = getSpaceContentKey(space.spaceId, space)
  const store = getStore()
  const core = store.get({ keyPair: deriveParticipationKeyPair(M, space.spaceId, space.driveSuffix), exclusive: true, encryptionKey: sck })
  const db = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json', metadata: { contentFeed: null } })
  const drive = new Hyperdrive(store, { _db: db, encryptionKey: sck })
  await drive.ready()
  const blobs = await drive.getBlobs()
  return { drive, blobs }
}

// Hyperdrive.close() closes the corestore it was handed — here the root — so only its own cores go.
async function releaseDrive({ drive, blobs }) {
  await blobs.core.close()
  await drive.db.close()
}

async function storedDks() {
  const out = new Set()
  for await (const dk of getStore().list()) out.add(b4a.toString(dk, 'hex'))
  return out
}

const dkOf = (core) => b4a.toString(core.discoveryKey, 'hex')

test('the computed keys are the keys the old drive had', async (t) => {
  const M = crypto.randomBytes(32)
  await freshDurable(t, { masterSecret: M })
  const space = await getSpace((await createSpace('Aurora')).spaceId)
  const old = await plantOldDrive(M, space)

  t.is(b4a.toString(old.drive.key, 'hex'), ownParticipationId(space.spaceId, space.driveSuffix), 'the participation id is the drive key')
  const { publicKey } = deriveParticipationKeyPair(M, space.spaceId, space.driveSuffix)
  t.alike(blobsKeyFor({ signers: [{ publicKey }] }), old.blobs.core.key, 'and the blobs key derives the way Hyperdrive derives it')
  t.alike(blobsKeyFor(old.drive.core.manifest), old.blobs.core.key, 'from the stored manifest too')
  await releaseDrive(old)
})

test('an empty old drive loses both cores, once', async (t) => {
  const M = crypto.randomBytes(32)
  await freshDurable(t, { masterSecret: M })
  const space = await getSpace((await createSpace('Aurora')).spaceId)
  const old = await plantOldDrive(M, space)
  const cores = [dkOf(old.drive.core), dkOf(old.blobs.core)]
  await releaseDrive(old)
  const before = await storedDks()
  t.ok(cores.every((dk) => before.has(dk)), 'precondition: both cores are on disk')

  const res = await retireSpaceDrives()
  t.is(res.status, 'done')
  t.is(res.purged, 2, 'the metadata core and the blobs core')
  t.is(res.compact, false, 'empty cores are not worth a full-range compaction')
  const after = await storedDks()
  t.absent(cores.some((dk) => after.has(dk)), 'neither core is left')

  t.is((await retireSpaceDrives()).status, 'skipped', 'the flag keeps it to one run')
})

test('a space that never had a drive is a no-op', async (t) => {
  await freshDurable(t, { masterSecret: crypto.randomBytes(32) })
  await createSpace('Aurora')
  const before = await storedDks()

  const res = await retireSpaceDrives()
  t.is(res.status, 'done')
  t.is(res.purged, 0)
  t.is(res.compact, false)
  const after = await storedDks()
  t.ok([...before].every((dk) => after.has(dk)), 'no core was deleted')
})

test('a drive holding blocks is left in place', async (t) => {
  const M = crypto.randomBytes(32)
  await freshDurable(t, { masterSecret: M })
  const space = await getSpace((await createSpace('Aurora')).spaceId)
  const old = await plantOldDrive(M, space)
  await old.drive.put('/kept.txt', b4a.from('not ours to delete'))
  const cores = [dkOf(old.drive.core), dkOf(old.blobs.core)]
  await releaseDrive(old)

  const res = await retireSpaceDrives()
  t.is(res.purged, 0)
  const after = await storedDks()
  t.ok(cores.every((dk) => after.has(dk)), 'both cores survive')
})

// Earlier releases opened each co-member's drive by the id their handshake carried; the replica sits
// in our store under that key, possibly with cached blocks.
test('a co-member drive replica is deleted, blocks and all', async (t) => {
  await freshDurable(t, { masterSecret: crypto.randomBytes(32) })
  const { spaceId } = await createSpace('Aurora')
  const replica = new Hyperdrive(getStore().namespace('peer-sim'))
  await replica.ready()
  await replica.put('/cached.bin', b4a.alloc(4096, 7))
  const blobs = await replica.getBlobs()
  const cores = [dkOf(replica.core), dkOf(blobs.core)]
  const driveKey = b4a.toString(replica.key, 'hex')
  await releaseDrive({ drive: replica, blobs })
  await mutateMembers(spaceId, () => [{ publicKey: 'ab'.repeat(32), driveKey, displayName: 'Peer' }])

  const res = await retireSpaceDrives()
  t.is(res.purged, 2)
  t.is(res.compact, true, 'cleared blocks are worth a compaction')
  const after = await storedDks()
  t.absent(cores.some((dk) => after.has(dk)), 'the replica is gone')
})

test('without the master secret it derives nothing and waits for a later boot', async (t) => {
  await freshDurable(t, { masterSecret: null })
  const res = await retireSpaceDrives()
  t.is(res.status, 'deferred')
})

// The migration leaves a drive with blocks for its space's leave, which deletes it whatever it holds.
test('the leave path deletes an own drive that holds blocks', async (t) => {
  const M = crypto.randomBytes(32)
  await freshDurable(t, { masterSecret: M })
  const space = await getSpace((await createSpace('Aurora')).spaceId)
  const old = await plantOldDrive(M, space)
  await old.drive.put('/legacy.bin', b4a.alloc(4096, 3))
  const cores = [dkOf(old.drive.core), dkOf(old.blobs.core)]
  await releaseDrive(old)

  const res = await purgeOwnRetiredDrive(space)
  t.is(res.purged, 2)
  t.ok(res.clearedBlocks)
  const after = await storedDks()
  t.absent(cores.some((dk) => after.has(dk)), 'both cores are gone')
})
