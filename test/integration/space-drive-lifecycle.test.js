import test from 'brittle'
import b4a from 'b4a'
import { freshPeer } from '../helpers/store.js'
import {
  createSpace, joinSpace, getSpace, getDrive, purgeSpaceDrive, removeSpace, materializeOwnDrive,
} from '../../src/shared/spaces/space.js'

// Leaving a space purges its drive (cores + alias). A later re-join of the same topic must NOT
// reopen the purged alias — that's the zombie-alias `STORAGE_EMPTY` crash. The record is cleared
// on leave, so the re-join mints a fresh `driveSuffix` and the drive built from it is brand new
// and empty. This guards both the crash and stale content leaking back after a leave.
//
// The own drive is built over the root corestore, so a purge that closes the drive wrong takes
// the whole store down with it — hence the "store stays usable" assertions below.

const GRANTED_SCK = b4a.from('ab'.repeat(32), 'hex')

test('purgeSpaceDrive removes the drive and the store stays usable', async (t) => {
  await freshPeer(t)
  const space = await createSpace('Aurora')
  await getDrive(space.spaceId).put('/f.txt', b4a.from('hi'))

  await purgeSpaceDrive(space.spaceId)
  t.absent(getDrive(space.spaceId), 'drive removed from the live map after purge')

  // The store is still healthy — another space can be created and used.
  const beta = await createSpace('Beta')
  t.ok(getDrive(beta.spaceId), 'store remains usable after a purge')
  await getDrive(beta.spaceId).put('/g.txt', b4a.from('ok'))
  t.ok(await getDrive(beta.spaceId).entry('/g.txt'), 'the new drive is writable')
})

test('re-joining after a purge gets a fresh, empty, writable drive (no zombie-alias reopen)', async (t) => {
  await freshPeer(t)
  const space = await createSpace('Aurora')
  const drive1 = getDrive(space.spaceId)
  await drive1.put('/old.txt', b4a.from('stale content'))
  const key1 = b4a.toString(drive1.key, 'hex')
  const suffix1 = (await getSpace(space.spaceId)).driveSuffix

  // Simulate leave: purge the drive (frees the alias) + drop the space record.
  await purgeSpaceDrive(space.spaceId)
  await removeSpace(space.spaceId)

  // Re-join the same topic. A join is always pending and mints a fresh driveSuffix — never the
  // purged alias — and the writable drive is built from it when the grant lands.
  const rejoined = await joinSpace(space.topic, 'Aurora')
  t.is(rejoined.pending, true, 'a re-join is pending, with no drive yet')
  t.absent(getDrive(space.spaceId), 'no drive is created while pending')
  t.not((await getSpace(space.spaceId)).driveSuffix, suffix1, 'a fresh driveSuffix, not the purged one')

  const drive2 = await materializeOwnDrive(space.spaceId, GRANTED_SCK)
  t.ok(drive2, 'the grant materialises a drive')
  t.not(b4a.toString(drive2.key, 'hex'), key1, 'a fresh drive (new key), not the purged alias')
  t.absent(await drive2.entry('/old.txt'), 'fresh drive is empty — stale content does not leak back')

  await drive2.put('/new.txt', b4a.from('fresh'))
  t.ok(await drive2.entry('/new.txt'), 'the fresh drive is writable (no STORAGE_EMPTY)')
})
