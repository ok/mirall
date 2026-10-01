import test from 'brittle'
import { deltaPlan, nextCoreEntry, validateManifest, MAX_CHAIN, MANIFEST_VERSION } from '../../src/shared/storage/backup/manifest.js'

const H = (c) => c.repeat(64)
const now = (over = {}) => ({ dk: H('a'), key: H('b'), role: 'profile', name: 'profile', spaceId: null, fork: 0, length: 10, contiguous: 10, treeHash: H('c'), ...over })
const entry = (over = {}) => ({ ...now(), segments: [{ from: 0, to: 10, parts: ['p1'] }], ...over })

test('a core is backed up whole the first time, then by what it gained', (t) => {
  t.alike(deltaPlan(null, now()), { kind: 'full', from: 0, to: 10 })
  t.alike(deltaPlan(entry(), now({ length: 14 })), { kind: 'delta', from: 10, to: 14 })
  t.alike(deltaPlan(entry(), now()), { kind: 'none' })
})

test('a fork, a shorter core or a full chain starts over from block 0', (t) => {
  t.alike(deltaPlan(entry(), now({ fork: 1, length: 12 })), { kind: 'full', from: 0, to: 12 }, 'forked')
  t.alike(deltaPlan(entry(), now({ length: 4 })), { kind: 'full', from: 0, to: 4 }, 'truncated')
  const long = entry({ segments: Array.from({ length: MAX_CHAIN }, (_, i) => ({ from: i ? 9 + i : 0, to: 10 + i, parts: ['p'] })) })
  t.alike(deltaPlan(long, now({ length: 50 })), { kind: 'full', from: 0, to: 50 }, 'chain at its cap')
})

test('a core that no longer extends what was captured starts over', (t) => {
  t.alike(deltaPlan(entry(), now({ length: 14, contiguous: 14 }), { extends: false }), { kind: 'full', from: 0, to: 14 })
})

test('a peer core whose earlier blocks arrived since is backed up whole again', (t) => {
  const sparse = entry({ role: 'peer', contiguous: 4 })
  t.alike(deltaPlan(sparse, now({ role: 'peer', contiguous: 10 })), { kind: 'full', from: 0, to: 10 })
  t.alike(deltaPlan(sparse, now({ role: 'peer', contiguous: 4 })), { kind: 'none' }, 'nothing new held, nothing to do')
})

test('an empty core is not backed up', (t) => {
  t.alike(deltaPlan(null, now({ length: 0, treeHash: null })), { kind: 'skip' })
})

test('the next entry extends, restarts or carries the chain', (t) => {
  const prev = entry()
  t.alike(nextCoreEntry(prev, now({ length: 14 }), { kind: 'delta', from: 10, to: 14 }, ['p2']).segments,
    [{ from: 0, to: 10, parts: ['p1'] }, { from: 10, to: 14, parts: ['p2'] }])
  t.alike(nextCoreEntry(prev, now({ fork: 1, length: 3 }), { kind: 'full', from: 0, to: 3 }, ['p3']).segments, [{ from: 0, to: 3, parts: ['p3'] }])
  const carried = nextCoreEntry(prev, now({ role: 'own-catalog', name: 'renamed', spaceId: 's' }), { kind: 'none' }, null)
  t.alike(carried.segments, prev.segments, 'an unchanged core keeps its chain')
  t.alike([carried.role, carried.name, carried.spaceId], ['own-catalog', 'renamed', 's'], 'and takes its current role')
})

const manifest = (cores) => ({ v: MANIFEST_VERSION, cores })

test('a manifest whose chains rebuild every core passes', (t) => {
  t.is(validateManifest(manifest([entry(), entry({ dk: H('d'), segments: [{ from: 0, to: 6, parts: ['x'] }, { from: 6, to: 10, parts: ['y', 'z'] }] })])), null)
})

test('a broken manifest names what is wrong', (t) => {
  t.ok(validateManifest(null))
  t.ok(validateManifest({ v: 2, cores: [] }))
  t.ok(/listed twice/.test(validateManifest(manifest([entry(), entry()]))))
  t.ok(/gap or overlap/.test(validateManifest(manifest([entry({ segments: [{ from: 0, to: 4, parts: ['a'] }, { from: 5, to: 10, parts: ['b'] }] })]))))
  t.ok(/gap or overlap/.test(validateManifest(manifest([entry({ segments: [{ from: 0, to: 6, parts: ['a'] }, { from: 4, to: 10, parts: ['b'] }] })]))))
  t.ok(/ends at 8/.test(validateManifest(manifest([entry({ segments: [{ from: 0, to: 8, parts: ['a'] }] })]))))
  t.ok(/no parts/.test(validateManifest(manifest([entry({ segments: [{ from: 0, to: 10, parts: [] }] })]))))
  t.ok(/malformed/.test(validateManifest(manifest([entry({ dk: 'zz' })]))))
  t.ok(/no tree hash/.test(validateManifest(manifest([entry({ treeHash: null })]))))
  t.ok(/not an object/.test(validateManifest(manifest([null]))), 'a null entry is reported, not thrown')
  t.ok(/malformed range/.test(validateManifest(manifest([entry({ segments: [null] })]))))
})
