import test from 'brittle'
import b4a from 'b4a'
import { freshPeer } from '../helpers/store.js'
import { setupOwnedShare } from '../helpers/owned.js'
import { getStore } from '../../src/shared/core/store.js'
import { ownCatalog, purgeOwnCatalog } from '../../src/shared/shares/share-catalog.js'

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
