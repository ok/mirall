import test from 'brittle'
import { classifyBeeKind } from '../../src/shared/storage/leftover-classify.js'

test('classifyBeeKind: a profile bee is recognised by its keys', (t) => {
  t.is(classifyBeeKind(['displayName', 'avatar']), 'profile')
  t.is(classifyBeeKind(['publicKey']), 'profile')
  t.is(classifyBeeKind(['member/abc123']), 'profile')
})

test('classifyBeeKind: a catalog bee is recognised by its file/ keys', (t) => {
  t.is(classifyBeeKind(['file/share-1/a.txt', 'file/share-1/b.txt']), 'catalog')
})

test('classifyBeeKind: anything else is an orphan', (t) => {
  t.is(classifyBeeKind(['/photo.bin', '/notes']), 'orphan')
  t.is(classifyBeeKind([]), 'orphan')
  t.is(classifyBeeKind(['caps/folder-shares', 'reclaim/space']), 'orphan')
})

test('classifyBeeKind: the overlay file-index is its own kind, never orphan', (t) => {
  t.is(classifyBeeKind(['chunkmap-oid:ab', 'file:/mir/ab', 'tree:cd']), 'file-index')
  t.is(classifyBeeKind(['chunkmap:content:ab']), 'file-index')
  t.is(classifyBeeKind(['config:sync']), 'file-index')
  t.is(classifyBeeKind(['sync:peerkey:/a']), 'file-index')
})
