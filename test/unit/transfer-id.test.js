import test from 'brittle'
import { LOOSE_SHARE_ID, transferIdFor, looseTransferIdFor, isLooseTransferId } from '../../src/shared/transfer/transfer-id.js'

// The renderer round-trips this id, so the separator and field order are a wire contract: a change
// here silently re-routes every pause/resume the UI sends back.
test('a transfer id is spaceId|shareId|relPath', (t) => {
  t.is(transferIdFor('space1', 'share1', 'a/b.txt'), 'space1|share1|a/b.txt')
  t.is(looseTransferIdFor('space1', 'a/b.txt'), `space1|${LOOSE_SHARE_ID}|a/b.txt`)
})

test('a relative path keeps its own separators', (t) => {
  t.is(transferIdFor('s', 'sh', 'deep/nested/name.txt').split('|')[2], 'deep/nested/name.txt')
})

test('ownership is decided from the id alone', (t) => {
  t.ok(isLooseTransferId(looseTransferIdFor('space1', 'f.txt')))
  t.absent(isLooseTransferId(transferIdFor('space1', 'share1', 'f.txt')))
})

// A caller routes on this before the transfer is known to exist, so a malformed or absent id must
// answer false rather than throw.
test('a malformed id is not loose', (t) => {
  for (const bad of [null, undefined, '', 'noseparators', 42, {}]) t.absent(isLooseTransferId(bad))
})

// A path containing the separator must not be readable as a shareId — the field count is what makes
// the id parseable at all.
test('a pipe in the path does not move the share field', (t) => {
  const id = transferIdFor('space1', 'share1', 'odd|name.txt')
  t.is(id.split('|')[1], 'share1')
  t.absent(isLooseTransferId(id))
})
