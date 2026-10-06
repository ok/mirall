import test from 'brittle'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createRequire } from 'node:module'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import hid from 'hypercore-id-encoding'
import PearRuntimeUpdater from 'pear-runtime-updater'
import { tmpDir } from '../helpers/tmp.js'
import { scaled } from '../helpers/timing.js'
import { waitFor } from '../helpers/poll.js'

const require = createRequire(import.meta.url)
const updateCache = require('../../src/main/update-cache.js')

// The update cache keeps only the latest version: a prune clears the blocks no file of the latest
// version for this platform references, and leaves that version whole. Under Node, as main runs it.

const host = `${process.platform}-${process.arch}`
const NAME = 'Mirall.AppImage'
const PREFIX = `/by-arch/${host}/app/${NAME}`
const PAYLOAD = 4 * 1024 * 1024

async function publish(drive, version, fill, { dedup = false } = {}) {
  await drive.put('/package.json', Buffer.from(JSON.stringify({ version })))
  if (dedup) await pipeline(Readable.from([Buffer.alloc(PAYLOAD, fill)]), drive.createWriteStream(PREFIX, { dedup: true }))
  else await drive.put(PREFIX, Buffer.alloc(PAYLOAD, fill))
  await drive.put(`/by-arch/other-arch/app/${NAME}`, Buffer.alloc(64 * 1024, fill))
}

function replicate(a, b, t) {
  const s1 = a.replicate(true)
  const s2 = b.replicate(false)
  s1.pipe(s2).pipe(s1)
  t.teardown(() => { s1.destroy(); s2.destroy() })
}

async function blocksOf(drive, name) {
  const { blob } = (await drive.entry(name)).value
  return [blob.blockOffset, blob.blockOffset + blob.blockLength]
}

async function stagedUpdater(t, opts) {
  const seedStore = new Corestore(tmpDir('update-cache-seed', t))
  const seed = new Hyperdrive(seedStore)
  await seed.ready()
  t.teardown(async () => { await seed.close(); await seedStore.close() })
  await publish(seed, '9.9.8', 1, opts)

  const dir = tmpDir('update-cache-stage', t)
  const store = new Corestore(path.join(dir, 'pear-runtime', 'corestore'))
  replicate(seedStore, store, t)
  const updater = new PearRuntimeUpdater({
    dir, app: path.join(dir, NAME), bundled: true, updates: true, version: '0.0.1',
    upgrade: `pear://${hid.encode(seed.key)}`, name: NAME, store, delay: 0,
  })
  updater.on('error', (err) => t.fail(`updater error: ${err.message}`))
  t.teardown(async () => { await updater.close(); await store.close() })
  await updater.ready()
  await updater._debouncedUpdate()
  await waitFor(() => updater.nextVersion === '9.9.8', 10000, { label: 'v1 staged' })
  return { seed, dir, updater }
}

async function stageNext(seed, updater, opts) {
  await publish(seed, '9.9.9', 2, opts)
  await waitFor(async () => { await updater.drive.update(); return updater.drive.core.length === seed.core.length }, 10000, { label: 'v2 seen' })
  await updater._debouncedUpdate()
  await waitFor(() => updater.nextVersion === '9.9.9', 10000, { label: 'v2 staged' })
}

test('a prune clears the older version and keeps the latest whole', { timeout: scaled(90000) }, async (t) => {
  const { seed, dir, updater } = await stagedUpdater(t)
  const v1 = await blocksOf(seed.checkout(seed.core.length), PREFIX)
  await stageNext(seed, updater)
  const v2 = await blocksOf(seed, PREFIX)
  const blobs = await updater.drive.getBlobs()
  t.ok(await blobs.core.has(v1[0], v1[1]), 'the older version is cached before the prune')

  const info = await updateCache.updateCacheInfo({ updater, dataDir: dir, prefix: PREFIX })
  t.ok(info.reclaimableBytes > 3 * 1024 * 1024, 'about the older payload is reclaimable: ' + info.reclaimableBytes)
  const before = await updateCache.dirSize(path.join(dir, 'pear-runtime', 'corestore'))

  const { clearedBlocks } = await updateCache.pruneUpdateCache({ updater, prefix: PREFIX })
  t.ok(clearedBlocks >= v1[1] - v1[0], 'the older payload was cleared: ' + clearedBlocks + ' blocks')
  t.absent(await blobs.core.has(v1[0]), 'its first block is gone')
  t.absent(await blobs.core.has(v1[1] - 1), 'and its last')
  t.ok(await blobs.core.has(v2[0], v2[1]), 'every block of the latest version stays')
  const latest = updater.drive.checkout(updater.drive.core.length)
  t.is((await latest.get(PREFIX)).byteLength, PAYLOAD, 'the latest payload reads whole')
  t.is(JSON.parse(await latest.get('/package.json')).version, '9.9.9')
  await latest.close()
  const after = await updateCache.dirSize(path.join(dir, 'pear-runtime', 'corestore'))
  t.ok(before - after > 3 * 1024 * 1024, 'the store shrank by ' + (before - after) + ' bytes')

  t.alike(await updateCache.pruneUpdateCache({ updater, prefix: PREFIX }), { clearedBlocks: 0 }, 'a second prune has nothing to clear')
})

test('REGRESSION (update cache estimate): a block-mapped latest version is not offered as reclaimable', { timeout: scaled(90000) }, async (t) => {
  const { seed, dir, updater } = await stagedUpdater(t, { dedup: true })
  await stageNext(seed, updater, { dedup: true })
  t.ok((await seed.entry(PREFIX)).value.blob.blockMap, 'the payload is stored behind a block map')

  const info = await updateCache.updateCacheInfo({ updater, dataDir: dir, prefix: PREFIX })
  const store = await updateCache.dirSize(path.join(dir, 'pear-runtime', 'corestore'))
  t.ok(info.reclaimableBytes > 3 * 1024 * 1024, 'about the older payload is reclaimable: ' + info.reclaimableBytes)
  t.ok(info.reclaimableBytes < store - 3 * 1024 * 1024, 'the latest payload is not: ' + info.reclaimableBytes + ' of ' + store)
})

test('a version not fully on this device is left whole', { timeout: scaled(60000) }, async (t) => {
  const { updater } = await stagedUpdater(t)
  t.alike(await updateCache.pruneUpdateCache({ updater, prefix: '/by-arch/other-arch/app/' + NAME }), { clearedBlocks: 0 },
    'another platform\'s files were never fetched, so nothing is cleared')
})

test('an empty drive has nothing to prune', async (t) => {
  const store = new Corestore(tmpDir('update-cache-empty', t))
  const drive = new Hyperdrive(store)
  await drive.ready()
  t.teardown(async () => { await drive.close(); await store.close() })
  t.alike(await updateCache.pruneUpdateCache({ updater: { drive, store }, prefix: PREFIX }), { clearedBlocks: 0 })
})
