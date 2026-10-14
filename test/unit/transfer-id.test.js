import test from 'brittle'
import { LOOSE_SHARE_ID, transferIdFor, looseTransferIdFor, transferIdParts, looseDrivePath, looseRelPath } from '../../src/shared/transfer/transfer-id.js'
import { LOOSE_SHARE_ID as CONTRACT_LOOSE_SHARE_ID } from '../../src/shared/contract/entry-ref.js'

// PERSISTED: verified records, pending rows and transfer ids carry it, and the renderer pins the loose
// listing's scope to it; there is one declaration, in the contract.
test('the loose share id is one persisted value', (t) => {
  t.is(LOOSE_SHARE_ID, '__loose__')
  t.is(LOOSE_SHARE_ID, CONTRACT_LOOSE_SHARE_ID, 'transfer-id.js re-exports the contract\'s value')
})

// The renderer round-trips this id, so the separator and field order are a wire contract: a change
// here silently re-routes every pause/resume the UI sends back.
test('a transfer id is spaceId|shareId|relPath', (t) => {
  t.is(transferIdFor('space1', 'share1', 'a/b.txt'), 'space1|share1|a/b.txt')
  t.is(looseTransferIdFor('space1', 'a/b.txt'), `space1|${LOOSE_SHARE_ID}|a/b.txt`)
})

test('a relative path keeps its own separators', (t) => {
  t.is(transferIdFor('s', 'sh', 'deep/nested/name.txt').split('|')[2], 'deep/nested/name.txt')
})

test('the id names its share alone, loose or folder', (t) => {
  t.is(transferIdParts(looseTransferIdFor('space1', 'f.txt')).shareId, LOOSE_SHARE_ID)
  t.is(transferIdParts(transferIdFor('space1', 'share1', 'f.txt')).shareId, 'share1')
})

// A caller routes on this before the transfer is known to exist, so a malformed or absent id must
// answer null rather than throw.
test('a malformed id has no parts', (t) => {
  for (const bad of [null, undefined, '', 'noseparators', 42, {}]) t.is(transferIdParts(bad), null)
})

// A path containing the separator must not be readable as a shareId — the field count is what makes
// the id parseable at all.
test('a pipe in the path does not move the share field', (t) => {
  const id = transferIdFor('space1', 'share1', 'odd|name.txt')
  t.is(id.split('|')[1], 'share1')
  t.is(transferIdParts(id).shareId, 'share1')
  t.is(transferIdParts(id).relPath, 'odd|name.txt')
})

// PERSISTED: the drive path keys a loose file's pending row and its download claim.
test('the drive path and the relPath round-trip', (t) => {
  t.is(looseDrivePath('sub/a.bin'), '/sub/a.bin')
  t.is(looseRelPath('/sub/a.bin'), 'sub/a.bin')
  t.is(looseRelPath('sub/a.bin'), 'sub/a.bin', 'a bare relPath stays')
})
