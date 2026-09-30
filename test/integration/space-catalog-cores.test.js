import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { freshPeer } from '../helpers/store.js'
import { beeDiscoveryKeyHex, localBeeDiscoveryKeys, createBee, createLocalBeeScratch, getStore } from '../../src/shared/core/store.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { getSpace, upsertMember } from '../../src/shared/spaces/space.js'
import { getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import { ownCatalog, ownCatalogKeyHex, plaintextCatalogName } from '../../src/shared/shares/own-catalog.js'
import { auditBee } from '../../src/shared/audit/audit-log.js'
import { spaceCatalogCores, dkOfKey } from '../../src/shared/storage/space-catalog-cores.js'

const dkHex = (core) => b4a.toString(core.discoveryKey, 'hex')

test('a named bee\'s discovery key is derived without opening it', async (t) => {
  await freshPeer(t)
  const space = await createSpace('Aurora')
  const own = await ownCatalog(space.spaceId)
  const { own: ownDks } = await spaceCatalogCores(await getSpace(space.spaceId))
  t.ok(ownDks.includes(dkHex(own.core)), 'the own catalog resolves to the core ownCatalog opened')

  const audit = auditBee()
  await audit.ready()
  const auditDks = await localBeeDiscoveryKeys('audit-log')
  t.ok(auditDks.includes(dkHex(audit.core)), 'a local bee resolves to its /v2 core')
  const scratch = createLocalBeeScratch('audit-log')
  await scratch.ready()
  t.teardown(() => scratch.close())
  t.ok(auditDks.includes(dkHex(scratch.core)), 'and to the boot rewrite\'s scratch copy, which holds the same data')

  const legacyName = plaintextCatalogName(space.spaceId, await getSpace(space.spaceId))
  const legacy = createBee(legacyName)
  await legacy.ready()
  t.teardown(() => legacy.close())
  t.ok(ownDks.includes(dkHex(legacy.core)), 'a legacy plaintext catalog is counted as the space\'s own')

  // A member whose profile never replicated: its rows cannot be read, and must not be opened for.
  await upsertMember(space.spaceId, { publicKey: b4a.toString(crypto.keyPair().publicKey, 'hex') })
  const before = new Set()
  for await (const dk of getStore().list()) before.add(b4a.toString(dk, 'hex'))
  await spaceCatalogCores(await getSpace(space.spaceId))
  await beeDiscoveryKeyHex('never-opened-bee')
  await localBeeDiscoveryKeys('never-opened-bee')
  let created = 0
  for await (const dk of getStore().list()) if (!before.has(b4a.toString(dk, 'hex'))) created++
  t.is(created, 0, 'resolving opens no core')
})

test('member catalogs come from the member record and never include our own', async (t) => {
  await freshPeer(t)
  const space = await createSpace('Aurora')
  const peerCatalog = b4a.toString(crypto.keyPair().publicKey, 'hex')
  await upsertMember(space.spaceId, { publicKey: b4a.toString(crypto.keyPair().publicKey, 'hex'), looseCatalogKey: peerCatalog })
  await upsertMember(space.spaceId, { publicKey: getLocalPublicKeyHex(), looseCatalogKey: await ownCatalogKeyHex(space.spaceId) })
  await upsertMember(space.spaceId, { publicKey: 'not-a-key', looseCatalogKey: b4a.toString(crypto.keyPair().publicKey, 'hex') })

  const { own, members } = await spaceCatalogCores(await getSpace(space.spaceId))
  t.alike(members, [dkOfKey(peerCatalog)], 'one member catalog: ours is excluded and a malformed member is skipped')
  t.ok(own.includes(dkOfKey(await ownCatalogKeyHex(space.spaceId))))
})
