import test from 'brittle'
import { createRefCountedLru } from '../../src/shared/core/lru.js'

test('evicts the oldest entry once the limit is passed', (t) => {
  const evicted = []
  const lru = createRefCountedLru({ limit: 2, onEvict: (k) => evicted.push(k) })
  lru.set('a', 1); lru.set('b', 2); lru.set('c', 3)
  t.alike(lru.keys(), ['b', 'c'], 'the oldest went')
  t.alike(evicted, ['a'], 'and onEvict fired for it')
})

test('get promotes an entry so it is not the next victim', (t) => {
  const evicted = []
  const lru = createRefCountedLru({ limit: 2, onEvict: (k) => evicted.push(k) })
  lru.set('a', 1); lru.set('b', 2)
  lru.get('a')
  lru.set('c', 3)
  t.alike(evicted, ['b'], 'the untouched entry was evicted, not the recently used one')
})

// REGRESSION (FIX-CATALOG-LRU: the values are live Hyperbee handles. Evicting one while a caller
// is mid-read closes the bee underneath it — trading a memory bound for a correctness bug.)
test('REGRESSION (FIX-CATALOG-LRU): an in-use entry is never evicted underneath its reader', (t) => {
  const evicted = []
  const lru = createRefCountedLru({ limit: 1, onEvict: (k) => evicted.push(k) })
  lru.set('pinned', 'handle')
  t.is(lru.acquire('pinned'), 'handle', 'acquire hands back the value')

  lru.set('b', 2); lru.set('c', 3); lru.set('d', 4)
  t.ok(lru.has('pinned'), 'the pinned entry survived every eviction pass')
  t.absent(evicted.includes('pinned'), 'and was never handed to onEvict')

  // Releasing alone frees nothing: with the pinned entry the only one left, there is no pressure.
  lru.release('pinned')
  t.ok(lru.has('pinned'), 'still cached — a release is not a drop')

  // Pressure now finds it evictable.
  lru.set('e', 5)
  t.absent(lru.has('pinned'), 'once unpinned it evicts like any other entry')
  t.ok(evicted.includes('pinned'), 'and went through onEvict so its handle is closed')
})

test('nested acquires need matching releases', (t) => {
  const lru = createRefCountedLru({ limit: 1 })
  lru.set('k', 1)
  lru.acquire('k'); lru.acquire('k')
  t.is(lru.refsOf('k'), 2)
  lru.set('other', 2)
  t.ok(lru.has('k'), 'still pinned while two refs are outstanding')
  lru.release('k')
  t.is(lru.refsOf('k'), 1, 'one ref still outstanding')
  lru.set('another', 3)
  t.ok(lru.has('k'), 'and it survives pressure')
  lru.release('k')
  lru.set('third', 4)
  t.absent(lru.has('k'), 'evicted under pressure once the last reader let go')
})

test('a limit of zero never evicts (the rollback path)', (t) => {
  const evicted = []
  const lru = createRefCountedLru({ limit: 0, onEvict: (k) => evicted.push(k) })
  for (let i = 0; i < 500; i++) lru.set('k' + i, i)
  t.is(lru.size(), 500)
  t.is(evicted.length, 0, 'unbounded, as before')
})

test('the limit is read per operation', (t) => {
  let cap = 0
  const lru = createRefCountedLru({ limit: () => cap })
  for (let i = 0; i < 5; i++) lru.set('k' + i, i)
  t.is(lru.size(), 5, 'unbounded while the cap is 0')
  cap = 2
  lru.set('k5', 5)
  t.is(lru.size(), 2, 'tightens as soon as the cap does')
})

test('re-setting an existing key keeps its refcount', (t) => {
  const lru = createRefCountedLru({ limit: 1 })
  lru.set('k', 1)
  lru.acquire('k')
  lru.set('k', 2)
  t.is(lru.refsOf('k'), 1, 'the reader still holds it across a value refresh')
  t.is(lru.get('k'), 2, 'and sees the new value')
})

test('delete removes without firing onEvict', (t) => {
  const evicted = []
  const lru = createRefCountedLru({ limit: 5, onEvict: (k) => evicted.push(k) })
  lru.set('k', 'handle')
  t.is(lru.delete('k'), 'handle', 'hands the value back so the caller can close it')
  t.is(evicted.length, 0, 'an explicit delete is the caller doing the teardown itself')
})
