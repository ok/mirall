import test from 'brittle'
import b4a from 'b4a'
import { freshPeer } from '../helpers/store.js'
import { createBee } from '../../src/shared/core/store.js'
import { createSpace } from '../../src/shared/spaces/space.js'
import { getProfileBee } from '../../src/shared/spaces/profile.js'
import { classifyLeftovers } from '../../src/shared/storage/leftover.js'

// A stray bee that is not tied to any active space stands in for a peer profile
// / catalog cached from a prior connection. classifyLeftovers must surface those
// while leaving system bees (profile, spaces-meta) and active-space cores alone.
test('classifyLeftovers finds stray peer-shaped cores and excludes system bees', async (t) => {
  await freshPeer(t)
  await createSpace('Aurora')

  const strayProfile = createBee('past-peer-profile-sim')
  await strayProfile.ready()
  await strayProfile.put('displayName', 'Ghost')
  await strayProfile.put('publicKey', 'deadbeef')

  const strayCatalog = createBee('past-catalog-sim')
  await strayCatalog.ready()
  await strayCatalog.put('file/share-1/a.txt', { size: 10, mtime: 1 })

  const profileDk = b4a.toString(getProfileBee().core.discoveryKey, 'hex')

  const scan = await classifyLeftovers()

  t.ok(scan.profiles.count >= 1, 'the stray profile is classified as a profile')
  t.ok(scan.catalogs.count >= 1, 'the stray catalog is classified as a catalog')

  const allKeys = [...scan.profiles.keys, ...scan.catalogs.keys].map((r) => r.discoveryKeyHex)
  t.absent(allKeys.includes(profileDk), 'the device profile bee is never a leftover')
})
