import test from 'brittle'
import b4a from 'b4a'
import { freshPeerWithIdentity } from '../helpers/store.js'
import { createLocalBee } from '../../src/shared/core/store.js'
import { createSpace } from '../../src/shared/spaces/space.js'
import { buildWantedKeys, classifyLeftovers } from '../../src/shared/storage/leftover.js'

async function localDk (name) {
  const bee = createLocalBee(name)
  await bee.core.ready()
  return b4a.toString(bee.core.discoveryKey, 'hex')
}

function leftoverDkSet (scan) {
  const dks = new Set()
  for (const r of scan.profiles.keys) dks.add(r.discoveryKeyHex)
  for (const r of scan.catalogs.keys) dks.add(r.discoveryKeyHex)
  for (const d of scan.orphanDrives.keys) {
    dks.add(d.metaDkHex)
    if (d.blobsDkHex) dks.add(d.blobsDkHex)
  }
  return dks
}

test('REGRESSION (MIR-40): encrypted /v2 metadata bees are wanted, never leftovers', async (t) => {
  await freshPeerWithIdentity(t)
  await createSpace('Aurora') // populates the encrypted spaces-meta v2 core

  const spacesDk = await localDk('spaces-meta')

  const wanted = await buildWantedKeys()
  t.ok(wanted.has(spacesDk), 'the encrypted spaces-meta v2 core is in the wanted set')

  const scan = await classifyLeftovers()
  t.absent(leftoverDkSet(scan).has(spacesDk), 'the encrypted bee is not classified as a leftover')
})
