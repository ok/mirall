import test from 'brittle'
import { serveIndex } from '../../src/shared/transfer/backends/overlay/overlay-serve-index.js'

test('add/spacesFor — single hash, single (space, share, path)', (t) => {
  serveIndex._reset()
  serveIndex.add('hashA', 'space1', 'share1', 'a.txt')
  t.alike([...serveIndex.spacesFor('hashA')], ['space1'])
  t.ok(serveIndex.has('hashA'))
})

test('spacesFor — unknown hash returns an empty (read-only) set', (t) => {
  serveIndex._reset()
  t.is([...serveIndex.spacesFor('nope')].length, 0)
  t.absent(serveIndex.has('nope'))
})

test('refsFor — recovers the (space, share, path) references for a hash', (t) => {
  serveIndex._reset()
  serveIndex.add('h', 'space1', '__loose__', 'report final.txt')
  t.alike(serveIndex.refsFor('h'), [{ spaceId: 'space1', shareId: '__loose__', relPath: 'report final.txt' }])
  t.alike(serveIndex.refsFor('missing'), [], 'unknown hash → empty array')
})

test('refsFor — preserves a relPath containing the same separators-as-text (NUL split is exact)', (t) => {
  serveIndex._reset()
  serveIndex.add('h', 'space1', 'share1', 'nested/dir/file.txt')
  t.alike(serveIndex.refsFor('h'), [{ spaceId: 'space1', shareId: 'share1', relPath: 'nested/dir/file.txt' }])
})

test('refcount — shared hash across two SPACES; removing one keeps it servable (R3)', (t) => {
  serveIndex._reset()
  serveIndex.add('shared', 'spaceA', 'share1', 'x.txt')
  serveIndex.add('shared', 'spaceB', 'share1', 'y.txt')
  t.is([...serveIndex.spacesFor('shared')].length, 2)

  serveIndex.remove('shared', 'spaceA', 'share1', 'x.txt')
  t.ok(serveIndex.has('shared'), 'still servable for spaceB')
  t.alike([...serveIndex.spacesFor('shared')], ['spaceB'])

  serveIndex.remove('shared', 'spaceB', 'share1', 'y.txt')
  t.absent(serveIndex.has('shared'), 'forgotten only when the last reference drops')
})

// The bug the per-path refcount fixes: content-addressed dedup means two paths in
// ONE space can share a hash. Deleting one must NOT revoke serve for the other.
test('refcount — two PATHS in the same space share a hash; deleting one keeps the other servable', (t) => {
  serveIndex._reset()
  serveIndex.add('dup', 'space1', 'share1', 'a.txt')
  serveIndex.add('dup', 'space1', 'share1', 'copy/a.txt')
  t.alike([...serveIndex.spacesFor('dup')], ['space1'], 'one distinct space, two references')

  serveIndex.remove('dup', 'space1', 'share1', 'a.txt')
  t.ok(serveIndex.has('dup'), 'hash still servable — copy/a.txt still advertises it')
  t.alike([...serveIndex.spacesFor('dup')], ['space1'], 'space still authorized')

  serveIndex.remove('dup', 'space1', 'share1', 'copy/a.txt')
  t.absent(serveIndex.has('dup'), 'forgotten once both paths are gone')
})

// The same relPath in two DIFFERENT shares of one space is two genuine references
// (e.g. a loose file and a folder-share file that happen to share a name + hash).
test('refcount — same relPath across two SHARES is two references', (t) => {
  serveIndex._reset()
  serveIndex.add('h', 'space1', '__loose__', 'a.txt')
  serveIndex.add('h', 'space1', 'folderShare', 'a.txt')
  t.is(serveIndex.refsFor('h').length, 2, 'two share references for the same path')

  serveIndex.remove('h', 'space1', '__loose__', 'a.txt')
  t.ok(serveIndex.has('h'), 'folderShare reference keeps it servable')
})

test('spacesFor — dedup distinct spaces across many references', (t) => {
  serveIndex._reset()
  serveIndex.add('h', 'sA', 'share1', 'p1')
  serveIndex.add('h', 'sA', 'share1', 'p2')
  serveIndex.add('h', 'sB', 'share1', 'p3')
  t.is([...serveIndex.spacesFor('h')].length, 2, 'sA counted once despite two paths')
})

test('add — idempotent for the same (space, share, path)', (t) => {
  serveIndex._reset()
  serveIndex.add('h', 's', 'share1', 'p')
  serveIndex.add('h', 's', 'share1', 'p')
  serveIndex.remove('h', 's', 'share1', 'p')
  t.absent(serveIndex.has('h'), 'a single remove clears a doubly-added identical reference')
})

test('add — tolerates a relPath containing spaces (NUL separator, not space)', (t) => {
  serveIndex._reset()
  serveIndex.add('h', 'space1', 'share1', 'my report final.txt')
  t.alike([...serveIndex.spacesFor('h')], ['space1'], 'spaceId parsed correctly despite spaces in the path')
})

test('add — ignores a falsy hash / spaceId / shareId / relPath', (t) => {
  serveIndex._reset()
  serveIndex.add('', 's', 'share1', 'p')
  serveIndex.add('h', '', 'share1', 'p')
  serveIndex.add('h', 's', '', 'p')
  serveIndex.add('h', 's', 'share1', null)
  t.absent(serveIndex.has(''))
  t.absent(serveIndex.has('h'))
})

test('remove — unknown hash is a no-op', (t) => {
  serveIndex._reset()
  serveIndex.remove('ghost', 'space', 'share1', 'p')
  t.pass('did not throw')
})
