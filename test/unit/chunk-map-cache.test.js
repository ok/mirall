import test from 'brittle'
import { createChunkMapCache } from '../../src/shared/transfer/chunk-map-cache.js'

const map = (n) => Array.from({ length: n }, (_, i) => ({ hash: String(i), offset: i, length: 1 }))

test('a hit returns the same array instance and does not re-decode', (t) => {
  const c = createChunkMapCache({ maxBytes: 1024 })
  const v = map(2)
  c.set('k', v, 100)
  t.is(c.get('k'), v, 'the cached array is shared by reference')
  t.is(c.size, 1)
  t.is(c.bytes, 100)
})

test('eviction is least-recently-used and the byte budget is honoured', (t) => {
  const c = createChunkMapCache({ maxBytes: 250 })
  c.set('a', map(1), 100)
  c.set('b', map(1), 100)
  t.is(c.get('a').length, 1, 'touching a makes b the least recent')
  c.set('c', map(1), 100)
  t.absent(c.get('b'), 'b was evicted, not a')
  t.ok(c.get('a'), 'a survived because it was touched')
  t.ok(c.get('c'))
  t.ok(c.bytes <= 250, 'the budget holds')
})

test('the newest entry is always admitted, even alone over the budget', (t) => {
  const c = createChunkMapCache({ maxBytes: 100 })
  const huge = map(3)
  c.set('huge', huge, 10_000)
  t.is(c.get('huge'), huge, 'a map larger than the whole budget is still cached')
  t.is(c.size, 1, 'and it is the only thing kept')
})

test('delete and clear release their bytes', (t) => {
  const c = createChunkMapCache({ maxBytes: 1000 })
  c.set('a', map(1), 100)
  c.set('b', map(1), 100)
  t.ok(c.delete('a'))
  t.absent(c.delete('a'), 'deleting twice is a no-op')
  t.is(c.bytes, 100, 'bytes follow the deletion')
  c.clear()
  t.is(c.size, 0)
  t.is(c.bytes, 0)
})

test('re-setting a key replaces its cost rather than adding to it', (t) => {
  const c = createChunkMapCache({ maxBytes: 1000 })
  c.set('a', map(1), 100)
  c.set('a', map(2), 300)
  t.is(c.size, 1)
  t.is(c.bytes, 300, 'the old cost is subtracted before the new one is added')
})

test('maxBytes 0 disables the cache — the runtime-config rollback gate', (t) => {
  const c = createChunkMapCache({ maxBytes: 0 })
  c.set('a', map(1), 100)
  t.absent(c.get('a'), 'set is a no-op and get always misses')
  t.is(c.size, 0)
  t.is(c.bytes, 0)
})

test('a missing or invalid maxBytes disables rather than unbounds', (t) => {
  for (const opts of [undefined, {}, { maxBytes: -5 }, { maxBytes: 'lots' }]) {
    const c = createChunkMapCache(opts)
    c.set('a', map(1), 100)
    t.is(c.size, 0, 'a memory bound fails closed, never open')
  }
})
