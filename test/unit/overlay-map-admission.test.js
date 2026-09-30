import test from 'brittle'
import { mapFault, maxMapEntries, sameMap } from '../../src/shared/transfer/backends/overlay/engine/scheduler/map-admission.js'
import { getTierParams } from '../../src/shared/transfer/backends/overlay/engine/chunker.js'

const tier = getTierParams(0)
const list = (...lengths) => lengths.map((length, i) => ({ hash: 'h' + i, length }))

test('with no known size any list is accepted, and only an adopted map constrains it', (t) => {
  t.is(mapFault(list(1, 2, 3), { expectedSize: null, tier: null, adopted: null }), null)
  t.is(mapFault(list(1, 2, 3), { expectedSize: null, tier: null, adopted: list(1, 2, 3) }), null)
  t.is(mapFault(list(1, 2), { expectedSize: null, tier: null, adopted: list(1, 2, 3) }), 'differs from the adopted map')
})

test('a list must sum to the known size', (t) => {
  t.is(mapFault(list(5000, 5000), { expectedSize: 10000, tier, adopted: null }), null)
  t.is(mapFault(list(5000, 4999), { expectedSize: 10000, tier, adopted: null }), 'size mismatch')
})

test('a list may hold no more entries than the size allows', (t) => {
  const bound = maxMapEntries(10000, tier)
  t.is(bound, Math.ceil(10000 / tier.minSize) + 1)
  t.is(mapFault(list(...new Array(bound + 1).fill(1)), { expectedSize: 10000, tier, adopted: null }), 'too many chunks')
})

test('every chunk length stays inside the tier', (t) => {
  for (const bad of [0, tier.maxSize + 1, 1.5, -1]) {
    t.is(mapFault(list(bad, 10000 - bad), { expectedSize: 10000, tier, adopted: null }), 'chunk length out of range', String(bad))
  }
})

test('a list that fits the size must still equal the adopted map', (t) => {
  const adopted = list(5000, 5000)
  const other = [{ hash: 'x', length: 5000 }, { hash: 'h1', length: 5000 }]
  t.is(mapFault(other, { expectedSize: 10000, tier, adopted }), 'differs from the adopted map')
})

test('maxMapEntries is null without a known size', (t) => {
  t.is(maxMapEntries(null, null), null)
})

test('sameMap compares hashes and lengths in order', (t) => {
  t.ok(sameMap(list(1, 2), list(1, 2)))
  t.absent(sameMap(list(1, 2), list(2, 1)))
  t.absent(sameMap(list(1), list(1, 2)))
  t.absent(sameMap(list(1), [{ hash: 'other', length: 1 }]))
})
