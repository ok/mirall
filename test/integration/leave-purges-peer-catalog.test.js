import test from 'brittle'
import b4a from 'b4a'
import { freshPeer } from '../helpers/store.js'
import { createBee, getStore } from '../../src/shared/core/store.js'
import { createSpace, getSpace, upsertMember, purgeSpace } from '../../src/shared/spaces/space.js'
import { forgetUnreferencedPeerCores } from '../../src/shared/storage/leftover.js'

async function coreInStore (dkHex) {
  for await (const dk of getStore().list()) {
    if (b4a.toString(dk, 'hex') === dkHex) return true
  }
  return false
}

// Real cores, not synthetic keys: purgeCoreDk no-ops on a discovery key with nothing behind it,
// so a test built on invented keys would pass without deleting anything.
async function plantCore (name, key, value) {
  const bee = createBee(name)
  await bee.ready()
  await bee.put(key, value)
  const keyHex = b4a.toString(bee.core.key, 'hex')
  const dkHex = b4a.toString(bee.core.discoveryKey, 'hex')
  await bee.close()
  return { keyHex, dkHex }
}

const memberOf = async (spaceId, publicKey) =>
  (await getSpace(spaceId)).members.find((m) => m.publicKey === publicKey)

// A member brought two cores with them: their profile bee and the catalog they advertise in the
// space. Only the profile was purged before, so the catalog outlived every leave — which is the
// leak the retired "Free up space" scan existed to mop up.
test('leaving takes the departed member’s catalog as well as their profile', async (t) => {
  await freshPeer(t)
  const space = await createSpace('Aurora')
  const profile = await plantCore('peer-profile-sim', 'displayName', 'Ghost')
  const catalog = await plantCore('peer-catalog-sim', 'file/share-1/a.txt', { size: 10, mtime: 1 })
  await upsertMember(space.spaceId, { publicKey: profile.keyHex, looseCatalogKeyEnc: catalog.keyHex })
  const member = await memberOf(space.spaceId, profile.keyHex)

  t.ok(await coreInStore(catalog.dkHex), 'precondition: the peer catalog is on disk')

  // The leave order: space-leave drops the record before it gcs peer cores, which is what makes
  // the departed member unreferenced. Moving this call earlier would silently make it a no-op.
  await purgeSpace(space.spaceId)
  await forgetUnreferencedPeerCores([member])

  t.absent(await coreInStore(catalog.dkHex), 'the catalog went with the member')
  t.absent(await coreInStore(profile.dkHex), 'and so did the profile')
})

// The one way this change can do real harm: a peer we still share another space with must keep
// everything they are still advertising.
test('a member we still share another space with keeps their cores', async (t) => {
  await freshPeer(t)
  const left = await createSpace('Aurora')
  const kept = await createSpace('Borealis')
  const profile = await plantCore('peer-profile-sim', 'displayName', 'Ghost')
  const catalogLeft = await plantCore('peer-catalog-left', 'file/share-1/a.txt', { size: 10, mtime: 1 })
  const catalogKept = await plantCore('peer-catalog-kept', 'file/share-2/b.txt', { size: 20, mtime: 2 })

  await upsertMember(left.spaceId, { publicKey: profile.keyHex, looseCatalogKeyEnc: catalogLeft.keyHex })
  await upsertMember(kept.spaceId, { publicKey: profile.keyHex, looseCatalogKeyEnc: catalogKept.keyHex })
  const member = await memberOf(left.spaceId, profile.keyHex)

  await purgeSpace(left.spaceId)
  await forgetUnreferencedPeerCores([member])

  t.absent(await coreInStore(catalogLeft.dkHex), 'the left space’s catalog is purged')
  t.ok(await coreInStore(profile.dkHex), 'the profile survives — they are still a member elsewhere')
  t.ok(await coreInStore(catalogKept.dkHex), 'and so does the catalog they still advertise')
})
