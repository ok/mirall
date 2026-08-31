import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { freshPeerWithIdentity } from '../helpers/store.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { createSpace, getSpace, getSpaceContentKey, upsertMember } from '../../src/shared/spaces/space.js'
import { getLocalPublicKeyHex, readProfileRecord } from '../../src/shared/spaces/profile.js'
import { publishShare } from '../../src/shared/shares/shares.js'
import { buildWantedKeys } from '../../src/shared/storage/leftover.js'
import {
  ownCatalogKeyHex, ownCatalogPublish, catalogNameFor, catalogKeyField,
  advertise, collectOwnShare, collectPeerShare, resolvePeerCatalog,
} from '../../src/shared/shares/share-catalog.js'

// A v2 (membership-gated) peer: identity keypair + the flags createSpace reads to pick schema v2.
async function v2Peer (t) {
  const ctx = await freshPeerWithIdentity(t)
  setRuntimeConfig({ ...getRuntimeConfig(), overlayEnabled: true, inPlaceFilesEnabled: true })
  return ctx
}

const SHARE = 'share-1'

test('v2 space: catalog is SCK-encrypted, key published in the …Enc field', async (t) => {
  await v2Peer(t)
  const space = await createSpace('Aurora')
  t.is(space.schemaVersion, 2, 'space is schema v2')

  const name = await catalogNameFor(space.spaceId)
  t.ok(name.endsWith('-e1'), 'v2 catalog uses the encrypted core name')

  const pub = await ownCatalogPublish(space.spaceId)
  t.is(pub.encrypted, true, 'ownCatalogPublish flags the catalog encrypted')
  t.is(pub.keyHex, await ownCatalogKeyHex(space.spaceId), 'publishes the encrypted core key')

  const rec = await readProfileRecord(getLocalPublicKeyHex(), space.spaceId)
  t.is(rec.looseCatalogKeyEnc, pub.keyHex, 'key published in loosecatEnc/')
  t.is(rec.looseCatalogKey, null, 'legacy plaintext loosecat/ field is NOT set for v2')
})

test('owner reads back its own encrypted catalog', async (t) => {
  await v2Peer(t)
  const space = await createSpace('Aurora')
  await advertise(space.spaceId, SHARE, 'a.txt', { size: 7, mtime: 1, contentHash: 'h-a' })
  await advertise(space.spaceId, SHARE, 'b.txt', { size: 9, mtime: 2, contentHash: 'h-b' })

  const { entries, total } = await collectOwnShare(space.spaceId, SHARE)
  t.is(total, 2, 'both entries counted')
  t.alike(entries.map((e) => e.relPath).sort(), ['a.txt', 'b.txt'], 'owner decrypts its own catalog')

  // Reading the SAME core by key WITH the SCK returns the entries — the member (approved) path.
  const sck = getSpaceContentKey(space.spaceId, await getSpace(space.spaceId))
  const keyHex = await ownCatalogKeyHex(space.spaceId)
  const asPeer = await collectPeerShare(keyHex, SHARE, { sck })
  t.is(asPeer.entries.length, 2, 'a holder of the SCK reads the encrypted catalog by key')
})

test('resolvePeerCatalog: …Enc demands the SCK, legacy stays plaintext', async (t) => {
  await v2Peer(t)
  const space = await createSpace('Aurora')
  const sck = getSpaceContentKey(space.spaceId, await getSpace(space.spaceId))

  const enc = await resolvePeerCatalog(space.spaceId, { catalogKeyEnc: 'AA', catalogKey: 'BB' })
  t.is(enc.keyHex, 'AA', 'encrypted field wins')
  t.is(enc.encrypted, true, 'flagged encrypted')
  t.ok(enc.readable, 'readable because we hold the SCK')
  t.alike(enc.sck, sck, 'the SCK is resolved for a v2 space we hold the key for')

  const looseEnc = await resolvePeerCatalog(space.spaceId, { looseCatalogKeyEnc: 'CC' })
  t.is(looseEnc.keyHex, 'CC', 'loose …Enc field resolved')
  t.is(looseEnc.encrypted, true)

  const legacy = await resolvePeerCatalog(space.spaceId, { catalogKey: 'BB' })
  t.is(legacy.keyHex, 'BB', 'legacy plaintext key resolved')
  t.is(legacy.encrypted, false, 'plaintext read needs no SCK')
  t.ok(legacy.readable, 'plaintext is readable with no SCK')
  t.is(legacy.sck, null)

  const none = await resolvePeerCatalog(space.spaceId, {})
  t.is(none.keyHex, null, 'no catalog key → nothing to read')
  t.absent(none.readable, 'no key → not readable')

  // A pending member resolving an encrypted key is NOT readable — the metadata gate. Uses a
  // space we hold no vault entry for: holding the SCK is exactly what the gate turns on.
  const otherId = 'ff'.repeat(8)
  const gated = await resolvePeerCatalog(otherId, { catalogKeyEnc: 'AA' }, { space: { spaceId: otherId } })
  t.absent(gated.readable, 'encrypted catalog with no SCK is gated (pending joiner reads nothing)')
})

// #326 / leftover: a v2 peer's encrypted catalog (published as catalogKeyEnc) must be kept in the
// wanted-set, or the orphan sweep would purge the live encrypted core.
test('a peer\'s encrypted catalog key is wanted (not treated as leftover)', async (t) => {
  await v2Peer(t)
  const space = await createSpace('Aurora')
  const encKey = await ownCatalogKeyHex(space.spaceId)
  const me = getLocalPublicKeyHex()
  // Publish a share carrying catalogKeyEnc and record ourselves as a member so localPeerCatalogKeys
  // reads it back from the (own) profile bee — the same path a real peer's key travels.
  await publishShare(space.spaceId, { id: 'sh', type: 'owned-folder', name: 'Docs', owner: me, ...catalogKeyField(encKey, true), createdAt: 1 })
  await upsertMember(space.spaceId, { publicKey: me })

  const wanted = await buildWantedKeys()
  const encDk = b4a.toString(crypto.discoveryKey(b4a.from(encKey, 'hex')), 'hex')
  t.ok(wanted.has(encDk), 'encrypted catalog discovery key is in the wanted set')
})
