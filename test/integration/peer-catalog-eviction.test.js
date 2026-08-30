import test from 'brittle'
import crypto from 'hypercore-crypto'
import { freshPeer } from '../helpers/store.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { getPeerEntry, getPeerEntryState, watchPeerCatalog, dropCatalog, peerCatalogCacheStats } from '../../src/shared/shares/share-catalog.js'

const keyFor = (n) => crypto.keyPair(Buffer.alloc(32, n)).publicKey.toString('hex')

async function withLimit (t, limit, fn) {
  const prev = getRuntimeConfig()
  setRuntimeConfig({ ...prev, peerCatalogCacheLimit: limit })
  t.teardown(() => setRuntimeConfig(prev))
  return fn()
}

// Opening a peer catalog is what caches it; a read on a key we hold no data for still opens the
// core, which is exactly the cost being bounded.
async function touch (keyHex) {
  await getPeerEntry(keyHex, 'share1', 'file.bin').catch(() => null)
}

test('the peer catalog cache is bounded', async (t) => {
  await freshPeer(t)
  await withLimit(t, 2, async () => {
    for (let i = 1; i <= 5; i++) await touch(keyFor(i))
    const stats = peerCatalogCacheStats()
    t.is(stats.size, 2, 'five catalogs opened, two kept')
    t.alike(stats.keys, [keyFor(4), keyFor(5)], 'and they are the two most recent')
  })
})

// REGRESSION (FIX-CATALOG-LRU: the cached values are live Hyperbees whose append listener drives
// the mirror loop. Evicting a watched catalog would stop that loop with no error anywhere.)
test('REGRESSION (FIX-CATALOG-LRU): a watched catalog is pinned against eviction', async (t) => {
  await freshPeer(t)
  await withLimit(t, 1, async () => {
    const watched = keyFor(10)
    const bee = watchPeerCatalog(watched, 'listener-1', () => {})
    t.ok(bee, 'the watch opened the catalog')
    t.is(peerCatalogCacheStats().refsOf(watched), 1, 'and pinned it')

    for (let i = 11; i <= 15; i++) await touch(keyFor(i))

    const stats = peerCatalogCacheStats()
    t.ok(stats.keys.includes(watched), 'the watched catalog survived every eviction pass')

    // Dropping the watch releases the pin, and the entry becomes ordinary cache.
    dropCatalog(null, watched)
    t.absent(peerCatalogCacheStats().keys.includes(watched), 'and the drop removed it')
  })
})

test('a limit of zero keeps the previous unbounded behaviour', async (t) => {
  await freshPeer(t)
  await withLimit(t, 0, async () => {
    for (let i = 20; i <= 28; i++) await touch(keyFor(i))
    t.is(peerCatalogCacheStats().size, 9, 'every catalog stayed open')
  })
})

test('an evicted catalog re-opens transparently on the next read', async (t) => {
  await freshPeer(t)
  await withLimit(t, 1, async () => {
    const first = keyFor(30)
    await touch(first)
    await touch(keyFor(31))
    t.absent(peerCatalogCacheStats().keys.includes(first), 'evicted')

    await touch(first)
    t.ok(peerCatalogCacheStats().keys.includes(first), 'the cache is a cache, not a registry')
  })
})

// REGRESSION (FIX-CATALOG-READ-PIN: the read paths hold the bee across two awaits — the head sync
// and the get. With refs at zero, a catalog opened by a CONCURRENT read evicts and closes the bee
// mid-read, and the get lands on a closed handle. Pinning the watcher was not enough; the readers
// need it too.)
test('REGRESSION (FIX-CATALOG-READ-PIN): a concurrent open cannot evict a catalog mid-read', async (t) => {
  await freshPeer(t)
  await withLimit(t, 1, async () => {
    const reading = keyFor(40)

    // Two reads in flight against different catalogs, with room for exactly one. The first must
    // survive its own awaits even though the second's open triggers an eviction pass.
    const inFlight = getPeerEntryState(reading, 'share1', 'file.bin').catch(() => null)
    const other = getPeerEntryState(keyFor(41), 'share1', 'file.bin').catch(() => null)

    t.is(peerCatalogCacheStats().refsOf(reading), 1, 'the in-flight read pinned its catalog')
    await Promise.all([inFlight, other])
    t.is(peerCatalogCacheStats().refsOf(reading), 0, 'and released it when it finished')
  })
})
