import test from 'brittle'
import { createCatalogBatch } from '../../src/shared/shares/catalog-writer.js'
import { fileKey } from '../../src/shared/shares/share-catalog.js'

function fakeBee(initial = {}) {
  const store = new Map(Object.entries(initial))
  const calls = { batches: 0, puts: 0, flushes: 0 }
  return {
    calls,
    store,
    batch() {
      calls.batches++
      return {
        async get(k) { return store.has(k) ? { value: store.get(k) } : null },
        async put(k, v) { calls.puts++; store.set(k, v) },
        async flush() { calls.flushes++ },
      }
    },
  }
}

function fakeClock() {
  let now = 0
  const timers = new Map()
  let id = 1
  return {
    schedule: (fn, ms) => { const tid = id++; timers.set(tid, { fn, at: now + ms }); return tid },
    clear: (tid) => timers.delete(tid),
    advance: (ms) => { now += ms; for (const [tid, x] of [...timers]) if (x.at <= now) { timers.delete(tid); x.fn() } },
  }
}

// REGRESSION (FIX-133: the owner wrote ~2 un-batched catalog puts per file, flooding the consumer
// with appends and leaving the replicated head perpetually incomplete. A scan now batches writes
// into one atomic Hyperbee head per flush.)
test('REGRESSION (FIX-133): a folder scan batches catalog writes — one bee.batch per flush, not one put per file', async (t) => {
  const bee = fakeBee()
  const clk = fakeClock()
  const w = createCatalogBatch('sp', { flushMs: 2500, maxOps: 1000, schedule: clk.schedule, clear: clk.clear, resolveBee: () => bee })

  await w.advertise('sp', 'sh', 'a', { size: 1, mtime: 1 })
  await w.setMaterializedHash('sp', 'sh', 'a', 'hA')
  await w.advertise('sp', 'sh', 'b', { size: 2, mtime: 2 })
  t.is(bee.calls.batches, 0, 'nothing written before flush')

  clk.advance(2500)
  await w.close()
  t.is(bee.calls.batches, 1, 'one batch for the whole window')
  t.is(bee.calls.flushes, 1, 'one atomic head')
  t.is(bee.calls.puts, 2, 'two files written (a = merged advertise+hash, b)')
  t.alike(bee.store.get('file/sh/a'), { size: 1, mtime: 1, contentHash: 'hA' }, 'advertise+setHash coalesced into one value')
})

test('the op cap forces a flush before the timer', async (t) => {
  const bee = fakeBee()
  const clk = fakeClock()
  const w = createCatalogBatch('sp', { flushMs: 999999, maxOps: 3, schedule: clk.schedule, clear: clk.clear, resolveBee: () => bee })
  await w.advertise('sp', 'sh', 'f0', { size: 0, mtime: 0 })
  await w.advertise('sp', 'sh', 'f1', { size: 1, mtime: 1 })
  await w.advertise('sp', 'sh', 'f2', { size: 2, mtime: 2 })
  await w.flush()
  t.is(bee.calls.batches, 1, 'flushed at the op cap without waiting for the timer')
  await w.close()
})

test('setMaterializedHash with no buffered base merges onto the committed value', async (t) => {
  const bee = fakeBee({ 'file/sh/a': { size: 1, mtime: 1, contentHash: null } })
  const w = createCatalogBatch('sp', { flushMs: 10, resolveBee: () => bee })
  await w.setMaterializedHash('sp', 'sh', 'a', 'hZ')
  await w.close()
  t.is(bee.store.get('file/sh/a').contentHash, 'hZ', 'merged hash onto the committed row')
})

test('tombstone overrides a pending put and soft-deletes', async (t) => {
  const bee = fakeBee({ 'file/sh/a': { size: 1, mtime: 1, contentHash: 'h' } })
  const w = createCatalogBatch('sp', { flushMs: 10, resolveBee: () => bee })
  await w.advertise('sp', 'sh', 'a', { size: 9, mtime: 9 })
  await w.tombstone('sp', 'sh', 'a')
  await w.close()
  t.ok(bee.store.get('file/sh/a').deletedAt, 'soft-deleted')
})

// REGRESSION (FIX-133: a single batch.flush() error must not poison the single-flight chain,
// reject close()/later flushes, or surface as an unhandled rejection — it is best-effort, like
// the old per-file try/catch. Ops staged after the error still commit.)
test('REGRESSION (FIX-133): a flush error is best-effort — the chain self-heals and close() never rejects', async (t) => {
  let failNext = true
  const store = new Map()
  const bee = {
    store,
    batch() {
      return {
        async get(k) { return store.has(k) ? { value: store.get(k) } : null },
        async put(k, v) { store.set(k, v) },
        async flush() { if (failNext) { failNext = false; throw new Error('transient storage error') } },
        async close() {},
      }
    },
  }
  const w = createCatalogBatch('sp', { flushMs: 999999, maxOps: 1000, resolveBee: () => bee })

  await w.advertise('sp', 'sh', 'a', { size: 1, mtime: 1 })
  await w.flush() // the failing flush resolves (best-effort) rather than rejecting
  t.pass('a failing flush resolved without rejecting (chain not poisoned)')

  await w.advertise('sp', 'sh', 'b', { size: 2, mtime: 2 })
  await w.close() // would reject if the chain were poisoned
  t.alike(bee.store.get('file/sh/b'), { size: 2, mtime: 2, contentHash: null }, 'ops staged after the error still commit')
})

// A publish that writes through a batch must read through it too: a bulk item's materialized hash
// can sit staged (or mid-flush) for up to the flush window, and a reader that consults only the
// bee re-hashes a file whose hash is already in hand.
test('get() reads through staged and in-flight ops (read-your-writes)', async (t) => {
  const bee = fakeBee({ [fileKey('sh', 'b')]: { size: 2, mtime: 2, contentHash: null } })
  bee.get = async (k) => (bee.store.has(k) ? { value: bee.store.get(k) } : null)
  const clk = fakeClock()
  const w = createCatalogBatch('sp', { flushMs: 2500, maxOps: 1000, schedule: clk.schedule, clear: clk.clear, resolveBee: () => bee })

  t.is(await w.get('sp', 'sh', 'a'), null, 'nothing anywhere')
  await w.advertise('sp', 'sh', 'a', { size: 1, mtime: 1 })
  t.alike(await w.get('sp', 'sh', 'a'), { relPath: 'a', size: 1, mtime: 1, contentHash: null }, 'a staged advertise is visible before any flush')
  await w.setMaterializedHash('sp', 'sh', 'a', 'h1')
  t.is((await w.get('sp', 'sh', 'a')).contentHash, 'h1', 'a staged hash is visible')
  await w.setMaterializedHash('sp', 'sh', 'b', 'h2')
  t.is((await w.get('sp', 'sh', 'b')).contentHash, 'h2', 'a staged hash overlays a bee-resident entry')
  await w.tombstone('sp', 'sh', 'a')
  t.is(await w.get('sp', 'sh', 'a'), null, 'a staged tombstone hides the entry')

  // Mid-flush: the ops have left the buffer but not yet landed in the bee.
  let release
  const origBatch = bee.batch.bind(bee)
  bee.batch = () => { const b = origBatch(); const f = b.flush; b.flush = async () => { await new Promise((r) => { release = r }); return f() }; return b }
  const flushing = w.flush()
  await new Promise((r) => setTimeout(r, 0))
  t.is((await w.get('sp', 'sh', 'b')).contentHash, 'h2', 'an in-flight hash is still visible')
  release()
  await flushing
  t.is(bee.store.get(fileKey('sh', 'b')).contentHash, 'h2', 'and it lands')
})


// Like fakeBee, but a batch's puts land only on flush() — a real Hyperbee batch is atomic, and
// the read-your-writes tests below are about the window in which a flush has NOT landed.
function txBee(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    store,
    get: async (k) => (store.has(k) ? { value: store.get(k) } : null),
    batch() {
      const pending = new Map()
      return {
        async get(k) { return pending.has(k) ? { value: pending.get(k) } : store.has(k) ? { value: store.get(k) } : null },
        async put(k, v) { pending.set(k, v) },
        async flush() { for (const [k, v] of pending) store.set(k, v) },
        async close() {},
      }
    },
  }
}

// REGRESSION (FIX-CATALOG-GET-SHADOW: get() read `buffer.get(key) ?? inflight.get(key)`, so a
// buffered setHash shadowed the in-flight put for the same key and fell through to a bee that did
// not hold the put yet → null for an advertised, hashed entry; a rerun reading that null
// re-advertised and re-hashed the whole file.)
test('REGRESSION (FIX-CATALOG-GET-SHADOW): a staged setHash over an in-flight put reads as the full entry', async (t) => {
  const bee = txBee()
  let release
  const origBatch = bee.batch.bind(bee)
  bee.batch = () => { const b = origBatch(); const f = b.flush; b.flush = async () => { await new Promise((r) => { release = r }); return f() }; return b }
  const w = createCatalogBatch('sp', { flushMs: 999999, maxOps: 1000, resolveBee: () => bee })

  await w.advertise('sp', 'sh', 'a', { size: 1, mtime: 1 })
  const flushing = w.flush()
  await new Promise((r) => setTimeout(r, 0))
  await w.setMaterializedHash('sp', 'sh', 'a', 'hA')
  t.alike(await w.get('sp', 'sh', 'a'), { relPath: 'a', size: 1, mtime: 1, contentHash: 'hA' }, 'put (in flight) + setHash (staged)')
  bee.batch = origBatch
  release()
  await flushing
  await w.close()
  t.alike(bee.store.get(fileKey('sh', 'a')), { size: 1, mtime: 1, contentHash: 'hA' })
})

// REGRESSION (FIX-CATALOG-GET-QUEUED: ops handed to a flush queued behind a running one sat in
// neither the buffer nor `inflight` until their turn came — invisible to get().)
test('REGRESSION (FIX-CATALOG-GET-QUEUED): ops in a flush queued behind another are still visible', async (t) => {
  const bee = txBee()
  let release
  const origBatch = bee.batch.bind(bee)
  bee.batch = () => { const b = origBatch(); const f = b.flush; b.flush = async () => { await new Promise((r) => { release = r }); return f() }; return b }
  const w = createCatalogBatch('sp', { flushMs: 999999, maxOps: 1000, resolveBee: () => bee })

  await w.advertise('sp', 'sh', 'a', { size: 1, mtime: 1 })
  const first = w.flush()
  await new Promise((r) => setTimeout(r, 0))
  await w.advertise('sp', 'sh', 'b', { size: 2, mtime: 2 })
  const second = w.flush()
  t.alike(await w.get('sp', 'sh', 'b'), { relPath: 'b', size: 2, mtime: 2, contentHash: null }, 'queued behind the running flush')
  await w.tombstone('sp', 'sh', 'b')
  t.is(await w.get('sp', 'sh', 'b'), null, 'a staged tombstone over the queued put')
  bee.batch = origBatch
  release()
  await first
  await second
  await w.close()
  t.ok(bee.store.get(fileKey('sh', 'b')).deletedAt, 'and it all lands in order')
})

test('get() layers a bee-resident entry under a queued setHash and a later put', async (t) => {
  const bee = fakeBee({ [fileKey('sh', 'a')]: { size: 1, mtime: 1, contentHash: null } })
  bee.get = async (k) => (bee.store.has(k) ? { value: bee.store.get(k) } : null)
  const w = createCatalogBatch('sp', { flushMs: 999999, maxOps: 1000, resolveBee: () => bee })
  await w.setMaterializedHash('sp', 'sh', 'a', 'h1')
  t.is((await w.get('sp', 'sh', 'a')).contentHash, 'h1')
  await w.advertise('sp', 'sh', 'a', { size: 9, mtime: 9 })
  t.alike(await w.get('sp', 'sh', 'a'), { relPath: 'a', size: 9, mtime: 9, contentHash: null }, 'a re-advertise replaces the staged hash')
  await w.close()
})

test('a staged write resolves to a promise for the flush that lands it', async (t) => {
  const bee = fakeBee({ [fileKey('sh', 'a')]: { size: 1, mtime: 1, contentHash: 'h' } })
  const clk = fakeClock()
  const w = createCatalogBatch('sp', { flushMs: 2500, maxOps: 1000, schedule: clk.schedule, clear: clk.clear, resolveBee: () => bee })
  const { landed } = await w.tombstone('sp', 'sh', 'a')
  let done = false
  landed.then(() => { done = true })
  await new Promise((r) => setTimeout(r, 0))
  t.absent(done, 'not before the flush')
  clk.advance(2500)
  await landed
  t.ok(bee.store.get(fileKey('sh', 'a')).deletedAt, 'landed means landed')
  await w.close()
})
