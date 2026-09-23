import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { freshPeer } from '../helpers/store.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { getSpace, getSpaceContentKey, upsertMember } from '../../src/shared/spaces/space.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { getLocalPublicKeyHex, readProfileRecord, getProfileBee } from '../../src/shared/spaces/profile.js'
import { publishShare, readOwnShares } from '../../src/shared/shares/shares.js'
import { buildWantedKeys } from '../../src/shared/storage/leftover.js'
import { catalogKeyField } from '../../src/shared/shares/catalog-keys.js'
import { ownCatalogKeyHex, ownCatalogPublish, catalogNameForSpace, advertise, collectOwnShare } from '../../src/shared/shares/own-catalog.js'
import { collectPeerShare, resolvePeerCatalog } from '../../src/shared/shares/peer-catalog.js'
// A v2 (membership-gated) peer: identity keypair + the flags createSpace reads to pick schema v2.
async function v2Peer(t) {
  const ctx = await freshPeer(t)
  setRuntimeConfig({ ...getRuntimeConfig(), overlayEnabled: true, inPlaceFilesEnabled: true })
  return ctx
}

const SHARE = 'share-1'

test('v2 space: catalog is SCK-encrypted, key published in the …Enc field', async (t) => {
  await v2Peer(t)
  const space = await createSpace('Aurora')
  t.is(space.schemaVersion, 2, 'space is schema v2')

  const name = catalogNameForSpace(space.spaceId, await getSpace(space.spaceId))
  t.ok(name.endsWith('-e1'), 'v2 catalog uses the encrypted core name')

  const pub = await ownCatalogPublish(space.spaceId, await getSpace(space.spaceId))
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

// The SCK epoch: every publisher writes 0 beside the encrypted key, every reader defaults an
// absent field to 0, and the key that comes out is the epoch-0 key.

test('the own publish, the share record and the profile bee all carry epoch 0', async (t) => {
  await v2Peer(t)
  const space = await createSpace('Aurora')
  const me = getLocalPublicKeyHex()
  const pub = await ownCatalogPublish(space.spaceId, await getSpace(space.spaceId))
  t.is(pub.epoch, 0)
  t.is((await ownCatalogPublish(space.spaceId, { ...(await getSpace(space.spaceId)), epoch: 3 })).epoch, 3, 'the epoch is the record\'s')

  const rec = await readProfileRecord(me, space.spaceId)
  t.is(rec.looseCatalogEpoch, 0, 'loosecatEpoch/ published')
  t.is(typeof rec.looseCatalogKeyEnc, 'string', 'loosecatEnc/ is still a bare string')
  t.is((await getProfileBee().get('loosecatEpoch/' + space.spaceId))?.value, 0, 'as its own row')

  await publishShare(space.spaceId, { id: SHARE, type: 'owned-folder', name: 'Docs', owner: me, ...catalogKeyField(pub.keyHex, true, 'catalogKey', pub.epoch), createdAt: 1 })
  const share = (await readOwnShares(space.spaceId)).find((s) => s.id === SHARE)
  t.is(share.catalogEpoch, 0)
  t.is(share.catalogKeyEnc, pub.keyHex)
})

test('a profile bee with no loosecatEpoch/ row (an older publisher) reads at epoch 0', async (t) => {
  await v2Peer(t)
  const space = await createSpace('Aurora')
  const me = getLocalPublicKeyHex()
  await getProfileBee().del('loosecatEpoch/' + space.spaceId)
  const rec = await readProfileRecord(me, space.spaceId)
  t.is(rec.looseCatalogEpoch, 0)
  t.is(typeof rec.looseCatalogKeyEnc, 'string', 'the key row is untouched')
  const r = await resolvePeerCatalog(space.spaceId, rec)
  t.is(r.epoch, 0)
  t.ok(r.readable, 'and the epoch-0 key reads it')
})

test('resolvePeerCatalog reads a record without catalogEpoch (an older owner) with the epoch-0 key', async (t) => {
  await v2Peer(t)
  const space = await createSpace('Aurora')
  const keyHex = await ownCatalogKeyHex(space.spaceId)
  const sck = getSpaceContentKey(space.spaceId, await getSpace(space.spaceId))
  const r = await resolvePeerCatalog(space.spaceId, { catalogKeyEnc: keyHex })
  t.is(r.epoch, 0)
  t.alike(r.sck, sck)
  t.ok(r.readable)
  const explicit = await resolvePeerCatalog(space.spaceId, { catalogKeyEnc: keyHex, catalogEpoch: 0 })
  t.alike(explicit.sck, sck, 'an explicit 0 is the same key')
  const loose = await resolvePeerCatalog(space.spaceId, { looseCatalogKeyEnc: keyHex, looseCatalogEpoch: 0 })
  t.alike(loose.sck, sck, 'a member record resolves the same way')
})

test('resolvePeerCatalog for an epoch we hold no key for is unreadable, not garbage', async (t) => {
  await v2Peer(t)
  const space = await createSpace('Aurora')
  const keyHex = await ownCatalogKeyHex(space.spaceId)
  const r = await resolvePeerCatalog(space.spaceId, { catalogKeyEnc: keyHex, catalogEpoch: 1 })
  t.is(r.epoch, 1)
  t.is(r.sck, null)
  t.absent(r.readable)
})
