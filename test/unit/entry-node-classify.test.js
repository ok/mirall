import test from 'brittle'
import { classifyEntryNode } from '../../src/shared/shares/share-catalog.js'

// REGRESSION (FIX-REMOVE-1): only an explicit deletedAt tombstone counts as a removal; an
// absent/unreadable entry is UNKNOWN and must never be mistaken for one (else replication lag
// or an offline owner would nuke a live download).
test('classifyEntryNode: a tombstoned node is removed', (t) => {
  t.alike(classifyEntryNode({ value: { size: 10, contentHash: 'a'.repeat(64), deletedAt: 123 } }), { removed: true })
})

test('classifyEntryNode: a live node reports its content, not removed', (t) => {
  const s = classifyEntryNode({ value: { size: 10, mtime: 5, contentHash: 'a'.repeat(64) } })
  t.is(s.removed, false)
  t.is(s.contentHash, 'a'.repeat(64))
  t.is(s.size, 10)
})

test('classifyEntryNode: a mid-rehash node (null hash, not deleted) is live-but-transient', (t) => {
  const s = classifyEntryNode({ value: { size: 10, contentHash: null } })
  t.is(s.removed, false)
  t.is(s.contentHash, null)
})

test('classifyEntryNode: an absent/unreadable node is null (UNKNOWN, never removed)', (t) => {
  t.is(classifyEntryNode(null), null)
  t.is(classifyEntryNode({ value: null }), null)
  t.is(classifyEntryNode(undefined), null)
})
