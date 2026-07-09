import test from 'brittle'
import b4a from 'b4a'
import { freshPeer, freshPeerWithIdentity } from '../helpers/store.js'
import {
  createSpace, joinSpace, getDrive, purgeSpaceDrive, removeSpace,
} from '../../src/shared/spaces/space.js'

// Leaving a space purges its drive (cores + alias). A later re-join of the same
// topic must NOT reopen the purged alias — that's the zombie-alias
// `STORAGE_EMPTY` crash. The record is cleared on leave, so re-join generates a
// fresh `driveSuffix` and gets a brand-new, empty drive. This guards both the
// crash and stale-content leaking back after a leave.
//
// Run in BOTH modes: in identity mode the own drive is built over the root
// corestore, so a purge that closes the drive wrong takes the whole store down.
const BOOTS = [
  { name: 'seed', boot: freshPeer },
  { name: 'identity', boot: freshPeerWithIdentity },
]

for (const { name, boot } of BOOTS) {
test(`purgeSpaceDrive removes the drive and the store stays usable [${name}]`, async (t) => {
  await boot(t)
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

test(`re-joining after a purge gets a fresh, empty, writable drive (no zombie-alias reopen) [${name}]`, async (t) => {
  await boot(t)
  const space = await createSpace('Aurora')
  const drive1 = getDrive(space.spaceId)
  await drive1.put('/old.txt', b4a.from('stale content'))
  const key1 = b4a.toString(drive1.key, 'hex')

  // Simulate leave: purge the drive (frees the alias) + drop the space record.
  await purgeSpaceDrive(space.spaceId)
  await removeSpace(space.spaceId)

  // Re-join the same topic. With the record gone, a fresh driveSuffix is used —
  // never the purged alias.
  await joinSpace(space.topic, 'Aurora')
  const drive2 = getDrive(space.spaceId)
  t.ok(drive2, 'a drive is present after re-join')
  t.not(b4a.toString(drive2.key, 'hex'), key1, 'a fresh drive (new key), not the purged alias')
  t.absent(await drive2.entry('/old.txt'), 'fresh drive is empty — stale content does not leak back')

  await drive2.put('/new.txt', b4a.from('fresh'))
  t.ok(await drive2.entry('/new.txt'), 'the fresh drive is writable (no STORAGE_EMPTY)')
})
}
