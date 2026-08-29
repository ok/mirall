import test from 'brittle'
import Protomux from 'protomux'
import crypto from 'hypercore-crypto'
import { Duplex } from 'streamx'
import { tmpStore, tmpDir, fs, path } from './overlay-vendor-helpers.js'
import { HyperOverlayV2 } from '../../src/shared/transfer/backends/overlay/vendor/overlay-v2.js'
import { FileIndex } from '../../src/shared/transfer/backends/overlay/vendor/file-index.js'
import { openFdCount } from '../../src/shared/transfer/backends/overlay/vendor/transfer.js'
import { createChunkMapCache } from '../../src/shared/transfer/chunk-map-cache.js'

function makeDuplex () {
  let aWrite, bWrite
  const a = new Duplex({ write (d, cb) { bWrite(d); cb() }, read () {} })
  const b = new Duplex({ write (d, cb) { aWrite(d); cb() }, read () {} })
  aWrite = (d) => a.push(d)
  bWrite = (d) => b.push(d)
  return [a, b]
}
const settle = (ms = 800) => new Promise((r) => setTimeout(r, ms))
const FILE_BYTES = 8 * 1024 * 1024 // tier 1: 64 KiB average chunk, so C is comfortably over 64

async function publisher (label, opts = {}) {
  const pub = new HyperOverlayV2(tmpStore(label), {
    namespace: 'mirall-overlay', destDir: tmpDir(label + '-d'), serveAuthorizer: async () => true, ...opts,
  })
  await pub.ready()
  const content = crypto.randomBytes(FILE_BYTES)
  const oid = crypto.data(content).toString('hex')
  const src = path.join(tmpDir(label + '-src'), 'big.bin')
  fs.writeFileSync(src, content)
  await pub.registerFile('/mir/' + oid, src, { contentHash: oid, size: content.length })
  return { pub, content, oid }
}

async function connect (pub, label) {
  const con = new HyperOverlayV2(tmpStore(label), { namespace: 'mirall-overlay', destDir: tmpDir(label + '-d') })
  await con.ready()
  const [pa, pb] = makeDuplex()
  pub.attachProtocol(Protomux.from(pa))
  con.attachProtocol(Protomux.from(pb))
  await settle()
  return con
}

// Count bee reads of the content-addressed map key — the storage decode the cache removes.
// A spy on getChunkMapByHash would count the same calls before AND after the fix (the cache
// sits below it), so the bee is the honest seam.
function spyDecodes (index, oid) {
  const counter = { n: 0 }
  const real = index._bee.get.bind(index._bee)
  index._bee.get = (key, ...rest) => {
    if (typeof key === 'string' && key.startsWith('chunkmap-oid:' + oid)) counter.n++
    return real(key, ...rest)
  }
  return counter
}

// REGRESSION (FIX-CHUNKMAP-CACHE: the chunk map was re-read and JSON-decoded from the
// file-index bee on EVERY chunk-need, and the scheduler re-assigns after each accepted chunk,
// so a steady-state need carries one index and one serve decoded the map about C times — 1.7 GB
// of JSON for a 1 GiB file, synchronously on the worker thread.)
test('REGRESSION (FIX-CHUNKMAP-CACHE): a serve decodes the chunk map once, not once per chunk-need', async (t) => {
  const { pub, content, oid } = await publisher('cmc-pub', {
    chunkMapCache: createChunkMapCache({ maxBytes: 32 * 1024 * 1024 }),
  })
  t.teardown(async () => { try { await pub.close() } catch {} })
  const C = (await pub._index.getChunkMapByHash(oid)).length
  t.ok(C >= 64, `fixture yields C=${C} chunks`)

  const decodes = spyDecodes(pub._index, oid)
  const con = await connect(pub, 'cmc-con')
  t.teardown(async () => { try { await con.close() } catch {} })
  const got = await con.fetchFile(oid, { timeout: 8000, reSeed: false })
  t.ok(got, 'consumer fetched the file')
  t.is(Buffer.compare(fs.readFileSync(got.destPath), content), 0, 'bytes match — receiver verification untouched')
  t.ok(decodes.n <= 2, `map decoded ${decodes.n}x for C=${C} (expected 1)`)
})

// GREEN guard for the rollback gate: with the cache disabled the bee is read per need, i.e.
// serveChunkMapCacheBytes 0 really restores the pre-fix path. Also documents the RED magnitude —
// this assertion holds before and after the fix.
test('FIX-CHUNKMAP-CACHE: maxBytes 0 disables the cache — the bee is read about once per chunk', async (t) => {
  const { pub, oid } = await publisher('cmc-off', { chunkMapCache: createChunkMapCache({ maxBytes: 0 }) })
  t.teardown(async () => { try { await pub.close() } catch {} })
  const C = (await pub._index.getChunkMapByHash(oid)).length
  const decodes = spyDecodes(pub._index, oid)
  const con = await connect(pub, 'cmc-off-con')
  t.teardown(async () => { try { await con.close() } catch {} })
  t.ok(await con.fetchFile(oid, { timeout: 8000, reSeed: false }))
  t.ok(decodes.n > C / 16, `uncached: ${decodes.n} decodes for C=${C} (about C expected)`)
})

// The cache can only ever be wrong by serving a stale map. Every write path to a chunk-map key
// must drop it — a put (re-prepare) and a del (evictContent on the last serve reference).
test('FIX-CHUNKMAP-CACHE: put and evict invalidate; the next read sees the bee', async (t) => {
  const cache = createChunkMapCache({ maxBytes: 1024 * 1024 })
  const index = new FileIndex(tmpStore('cmc-inv'), { chunkMapCache: cache })
  await index.ready()
  t.teardown(() => index.close())
  const oid = 'a'.repeat(64)
  const v1 = [{ hash: '1'.repeat(64), offset: 0, length: 10 }]
  const v2 = [{ hash: '2'.repeat(64), offset: 0, length: 20 }]

  await index.putChunkMapByHash(oid, v1)
  t.alike(await index.getChunkMapByHash(oid), v1)
  t.is(cache.size, 1, 'first read cached it')
  await index.putChunkMapByHash(oid, v2)
  t.alike(await index.getChunkMapByHash(oid), v2, 'a rewrite is visible on the next read, not the cached v1')
  await index.evictContent(oid)
  t.is(await index.getChunkMapByHash(oid), null, 'an evicted map reads as absent, not from the cache')
  t.is(cache.size, 0)
})

test('FIX-CHUNKMAP-CACHE: a decode in flight across a rewrite never caches the stale value', async (t) => {
  const cache = createChunkMapCache({ maxBytes: 1024 * 1024 })
  const index = new FileIndex(tmpStore('cmc-fence'), { chunkMapCache: cache })
  await index.ready()
  t.teardown(() => index.close())
  const oid = 'b'.repeat(64)
  const v1 = [{ hash: '1'.repeat(64), offset: 0, length: 10 }]
  const v2 = [{ hash: '2'.repeat(64), offset: 0, length: 20 }]
  await index.putChunkMapByHash(oid, v1)

  // Park the bee read after it has fetched v1, land the rewrite, then release it.
  const realGet = index._bee.get.bind(index._bee)
  let release
  const gate = new Promise((r) => { release = r })
  index._bee.get = async (key, ...rest) => {
    const v = await realGet(key, ...rest)
    if (String(key).startsWith('chunkmap-oid:')) await gate
    return v
  }
  const parked = index.getChunkMapByHash(oid)
  index._bee.get = realGet
  await index.putChunkMapByHash(oid, v2)
  release()
  t.alike(await parked, v1, 'the parked read returns what it read')
  t.alike(await index.getChunkMapByHash(oid), v2, 'but did not poison the cache')
})

// REGRESSION (FIX-CHUNKMAP-CACHE: readChunk opened, read synchronously and closed the served
// file once PER CHUNK — a 4 MiB tier-3 read blocked the worker loop each time. The serve loop
// now opens one fd per (peer, file), reads asynchronously, and releases it on channel close.)
test('REGRESSION (FIX-CHUNKMAP-CACHE): a serve opens the source once and releases it when the peer goes', async (t) => {
  const { pub, content, oid } = await publisher('cmc-fd', { serveFdIdleMs: 60000 })
  t.teardown(async () => { try { await pub.close() } catch {} })
  let opens = 0
  const realOpen = pub._transfer.openChunkSource.bind(pub._transfer)
  pub._transfer.openChunkSource = (...a) => { opens++; return realOpen(...a) }
  const base = openFdCount()

  const con = await connect(pub, 'cmc-fd-con')
  const got = await con.fetchFile(oid, { timeout: 8000, reSeed: false })
  t.ok(got && Buffer.compare(fs.readFileSync(got.destPath), content) === 0, 'fetched byte-exact')
  t.is(opens, 1, 'the source was opened once for the whole serve')
  t.is(openFdCount(), base + 1, 'one session fd held inside the idle window')
  await con.close()
  await settle(300)
  t.is(openFdCount(), base, 'channel close released it')
})

test('FIX-CHUNKMAP-CACHE: an idle serve session closes its fd on the sweep', async (t) => {
  const { pub, oid } = await publisher('cmc-idle', { serveFdIdleMs: 50 })
  t.teardown(async () => { try { await pub.close() } catch {} })
  const base = openFdCount()
  const con = await connect(pub, 'cmc-idle-con')
  t.teardown(async () => { try { await con.close() } catch {} })
  t.ok(await con.fetchFile(oid, { timeout: 8000, reSeed: false }))
  await settle(400)
  t.is(openFdCount(), base, 'idle sweep closed the session fd while the peer is still connected')
})

// A peer mirroring a large folder touches many files inside one idle window, so time alone does
// not bound the open-handle count — past the per-peer cap the least recently used idle handle is
// closed. Without it, EMFILE surfaces as chunks silently skipped.
test('FIX-CHUNKMAP-CACHE: a peer’s open serve sources stay bounded', async (t) => {
  const { pub, oid } = await publisher('cmc-cap', { serveFdIdleMs: 60000 })
  t.teardown(async () => { try { await pub.close() } catch {} })
  const con = await connect(pub, 'cmc-cap-con')
  t.teardown(async () => { try { await con.close() } catch {} })
  t.ok(await con.fetchFile(oid, { timeout: 8000, reSeed: false }))

  const peer = [...pub._protocol._peers.values()][0]
  t.ok(peer._serveFds, 'the serve session opened a source')

  // Drive the trim directly: fabricate more idle entries than the cap allows.
  for (let i = 0; i < 200; i++) peer._serveFds.set('/fake/' + i, { fd: -1, lastAt: 0, busy: 0, pendingClose: false })
  pub._protocol._trimServeFds(peer)
  t.ok(peer._serveFds.size <= 64, 'the map is trimmed to the per-peer cap (' + peer._serveFds.size + ')')
})
