import test from 'brittle'
import b4a from 'b4a'
import { freshPeer } from '../helpers/store.js'
import { getStore, createBee } from '../../src/shared/core/store.js'
import { createSpace, getDrive } from '../../src/shared/spaces/space.js'
import { getProfileBee, getProfile } from '../../src/shared/spaces/profile.js'
import { listSpaces } from '../../src/shared/spaces/space.js'
import { purgeLeftovers } from '../../src/shared/storage/leftover.js'

async function coreInStore (dkHex) {
  for await (const dk of getStore().list()) {
    if (b4a.toString(dk, 'hex') === dkHex) return true
  }
  return false
}

// FIX-3 — leftover cleanup must purge stray cached cores while never touching
// system bees (the space registry / device identity) or an active space's drive.
// A whitelist that omitted the system bees would silently wipe all spaces.
test('REGRESSION (FIX-3): cleanup removes leftovers, keeps system bees and active drives', async (t) => {
  await freshPeer(t)
  const space = await createSpace('Aurora')

  const stray = createBee('past-peer-profile-sim')
  await stray.ready()
  await stray.put('displayName', 'Ghost')
  const strayDk = b4a.toString(stray.core.discoveryKey, 'hex')

  const profileDk = b4a.toString(getProfileBee().core.discoveryKey, 'hex')
  const drive = getDrive(space.spaceId)
  await drive.ready()
  const driveDk = b4a.toString(drive.core.discoveryKey, 'hex')

  t.ok(await coreInStore(strayDk), 'precondition: stray core present')

  const res = await purgeLeftovers()
  t.ok(res.purged >= 1, 'at least the stray core was purged')

  t.absent(await coreInStore(strayDk), 'stray core purged')
  t.ok(await coreInStore(profileDk), 'device profile bee preserved')
  t.ok(await coreInStore(driveDk), 'active space drive preserved')
  t.ok(await getProfile(), 'profile still readable')
  const spaces = await listSpaces()
  t.ok(spaces.some((s) => s.spaceId === space.spaceId), 'space registry intact')
})
