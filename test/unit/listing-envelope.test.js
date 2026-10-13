import test from 'brittle'
import { emptyListing, looseListing } from '../../src/shared/transfer/listing-envelope.js'

const row = (size) => ({ path: '/f' + size, size, hash: '', mtime: 0, status: 'remote', localPath: null, owner: { displayName: 'O', publicKey: 'k' } })

test('a loose listing counts its rows and their bytes, and is never truncated', (t) => {
  const listing = looseListing([row(3), row(5)], false)
  t.is(listing.total, 2)
  t.is(listing.totalBytes, 8)
  t.is(listing.complete, false, 'the caller decides completeness')
  t.is(listing.truncated, false)
  t.is(listing.fileLimit, null)
})

test('a size that is not a number adds nothing to the bytes', (t) => {
  t.is(looseListing([row(4), { ...row(0), size: undefined }], true).totalBytes, 4)
})

test('the empty listing is complete and states every field', (t) => {
  t.alike(emptyListing(), { entries: [], complete: true, total: 0, totalBytes: 0, truncated: false, fileLimit: null })
  t.not(emptyListing().entries, emptyListing().entries, 'each answer is its own object')
})
