import test from 'brittle'
import b4a from 'b4a'
import { freshPeer } from '../helpers/store.js'
import { getStore, createBee } from '../../src/shared/core/store.js'
import { createSpace, listSpaces } from '../../src/shared/spaces/space.js'
import { getProfileBee } from '../../src/shared/spaces/profile.js'
import { cleanupOrphanedData } from '../../src/shared/storage/storage.js'

async function coreInStore (dkHex) {
  for await (const dk of getStore().list()) {
    if (b4a.toString(dk, 'hex') === dkHex) return true
  }
  return false
}

// FIX-3 — the previous orphan whitelist omitted the named system bees, so a
// blind purge would have wiped the space registry and device identity. The boot
// sweep must never touch them.
test('REGRESSION (FIX-3): cleanup preserves system bees and the space registry', async (t) => {
  await freshPeer(t)
  const space = await createSpace('Aurora')

  const profileDk = b4a.toString(getProfileBee().core.discoveryKey, 'hex')
  const spacesMeta = createBee('spaces-meta')
  await spacesMeta.ready()
  const spacesMetaDk = b4a.toString(spacesMeta.core.discoveryKey, 'hex')

  await cleanupOrphanedData()

  t.ok(await coreInStore(profileDk), 'profile bee survives')
  t.ok(await coreInStore(spacesMetaDk), 'spaces-meta bee survives')
  const spaces = await listSpaces()
  t.ok(spaces.some((s) => s.spaceId === space.spaceId), 'space registry intact')
})
