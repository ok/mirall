import test from 'brittle'
import { catalogKeyField, readCatalogKey, readCatalogEpoch, isEpoch } from '../../src/shared/shares/catalog-keys.js'

const KEY = 'ab'.repeat(32)

test('isEpoch admits a non-negative integer and nothing else', (t) => {
  t.ok(isEpoch(0))
  t.ok(isEpoch(7))
  t.absent(isEpoch(-1))
  t.absent(isEpoch(1.5))
  t.absent(isEpoch('0'))
  t.absent(isEpoch(null))
  t.absent(isEpoch(undefined))
  t.absent(isEpoch({}))
})

test('catalogKeyField writes the epoch beside the …Enc field, and nothing beside a plaintext key', (t) => {
  t.alike(catalogKeyField(KEY, true), { catalogKeyEnc: KEY, catalogEpoch: 0 })
  t.alike(catalogKeyField(KEY, true, 'looseCatalogKey'), { looseCatalogKeyEnc: KEY, looseCatalogEpoch: 0 })
  t.alike(catalogKeyField(KEY, true, 'catalogKey', 3), { catalogKeyEnc: KEY, catalogEpoch: 3 })
  t.alike(catalogKeyField(KEY, true, 'looseCatalogKey', 2), { looseCatalogKeyEnc: KEY, looseCatalogEpoch: 2 })
  t.alike(catalogKeyField(KEY, false), { catalogKey: KEY })
  t.alike(catalogKeyField(KEY, false, 'looseCatalogKey', 5), { looseCatalogKey: KEY }, 'plaintext carries no epoch')
})

test('readCatalogKey round-trips what catalogKeyField wrote', (t) => {
  t.alike(readCatalogKey(catalogKeyField(KEY, true, 'catalogKey', 4)), { keyHex: KEY, encrypted: true, epoch: 4 })
  t.alike(readCatalogKey(catalogKeyField(KEY, true, 'looseCatalogKey', 1)), { keyHex: KEY, encrypted: true, epoch: 1 })
  t.alike(readCatalogKey(catalogKeyField(KEY, false)), { keyHex: KEY, encrypted: false, epoch: 0 })
})

test('readCatalogEpoch defaults an absent epoch to 0 and reads a malformed one as 0', (t) => {
  t.is(readCatalogKey({ catalogKeyEnc: KEY }).epoch, 0, 'a record written before the field existed')
  t.is(readCatalogKey({ looseCatalogKeyEnc: KEY }).epoch, 0, 'a member record written before the field existed')
  t.is(readCatalogKey({ catalogKeyEnc: KEY, catalogEpoch: 2 }).epoch, 2)
  t.is(readCatalogKey({ looseCatalogKeyEnc: KEY, looseCatalogEpoch: '2' }).epoch, 0, 'a string is not an epoch')
  t.is(readCatalogKey({ looseCatalogKeyEnc: KEY, looseCatalogEpoch: -1 }).epoch, 0, 'a negative is not an epoch')
  t.is(readCatalogKey({ looseCatalogKeyEnc: KEY, looseCatalogEpoch: null }).epoch, 0, 'null reads as 0')
  t.is(readCatalogKey({ catalogKey: KEY, catalogEpoch: 5 }).epoch, 0, 'plaintext has no epoch')
  t.is(readCatalogEpoch(null), 0)
  t.is(readCatalogEpoch({}), 0)
})

test('readCatalogEpoch pairs the epoch with the key field that won', (t) => {
  t.is(readCatalogEpoch({ catalogKeyEnc: KEY, catalogEpoch: 3, looseCatalogEpoch: 9 }), 3, 'a share record reads catalogEpoch')
  t.is(readCatalogEpoch({ looseCatalogKeyEnc: KEY, looseCatalogEpoch: 9 }), 9, 'a member record reads looseCatalogEpoch')
  t.is(readCatalogEpoch({ looseCatalogKeyEnc: KEY, catalogEpoch: 3 }), 0, 'a share epoch never decrypts a loose catalog')
})
