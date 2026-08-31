import test from 'brittle'
import b4a from 'b4a'
import { freshPeer } from '../helpers/store.js'
import { setupOwnedShare } from '../helpers/owned.js'
import { getStore } from '../../src/shared/core/store.js'
import { ownCatalog, purgeOwnCatalog, catalogNameFor } from '../../src/shared/shares/share-catalog.js'
import { getSpace, purgeSpace } from '../../src/shared/spaces/space.js'

async function coreInStore (dkHex) {
  for await (const dk of getStore().list()) {
    if (b4a.toString(dk, 'hex') === dkHex) return true
  }
  return false
}

// The own catalog core used to leak on every leave (dropCatalog was never
// called). purgeOwnCatalog must actually delete it from the store.
test('purgeOwnCatalog deletes the space catalog core', async (t) => {
  await freshPeer(t)
  const { spaceId } = await setupOwnedShare(t)

  const bee = await ownCatalog(spaceId)
  const dk = b4a.toString(bee.core.discoveryKey, 'hex')
  t.ok(await coreInStore(dk), 'precondition: catalog core present')

  await purgeOwnCatalog(spaceId)

  t.absent(await coreInStore(dk), 'catalog core purged on leave')
})

// The leave flow deletes the space record BEFORE purging (space-leave.js reads it at :180,
// purges at :257, deletes at :260), so the record is handed in rather than re-read. Without it
// the driveSuffix is unavailable and the purge resolves a different core than the one in use.
test('purgeOwnCatalog resolves the encrypted core from the record it is handed', async (t) => {
  await freshPeer(t)
  const { spaceId } = await setupOwnedShare(t)

  const rec = await getSpace(spaceId)
  const name = await catalogNameFor(spaceId)
  t.ok(name.endsWith('-e1'), 'precondition: the catalog is the encrypted core')

  const bee = await ownCatalog(spaceId)
  const dk = b4a.toString(bee.core.discoveryKey, 'hex')
  t.ok(await coreInStore(dk), 'precondition: catalog core present')

  await purgeSpace(spaceId)
  t.absent(await getSpace(spaceId), 'precondition: the space record is gone')

  await purgeOwnCatalog(spaceId, rec)
  t.absent(await coreInStore(dk), 'the encrypted core is the one purged')
})
