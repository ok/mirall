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
const { trackUpdateDownload } = require('../../src/main/update-progress.js')

// The app's own count of an update download: the blocks of this platform's files that are not on
// the device when the download starts. It runs to 1 over exactly those, whether the files sit
// behind a block map or not, and whether or not part of the update is already here. Under Node,
// against a real updater, as main runs it.

const host = `${process.platform}-${process.arch}`
const NAME = 'Mirall.AppImage'
const PREFIX = `/by-arch/${host}/app/${NAME}`
const CHUNK = 64 * 1024
const CHUNKS = 64

function payload() {
  const chunks = []
  for (let i = 0; i < CHUNKS; i++) chunks.push(Buffer.alloc(CHUNK, i + 1))
  return chunks
}

async function publish(drive, { dedup }) {
  await drive.put('/package.json', Buffer.from(JSON.stringify({ version: '9.9.9' })))
  if (dedup) await pipeline(Readable.from(payload()), drive.createWriteStream(PREFIX, { dedup: true }))
  else await drive.put(PREFIX, Buffer.concat(payload()))
  await drive.put(`/by-arch/other-arch/app/${NAME}`, Buffer.alloc(CHUNK, 9))
}

function replicate(a, b, t) {
  const s1 = a.replicate(true)
  const s2 = b.replicate(false)
  s1.pipe(s2).pipe(s1)
  t.teardown(() => { s1.destroy(); s2.destroy() })
}

// The payload's blocks as the tracker counts them: a block-mapped file's map blocks and the data
// blocks the map names, or a plain file's own range.
async function payloadBlocks(drive) {
  const { blob } = (await drive.entry(PREFIX)).value
  const own = Array.from({ length: blob.blockLength }, (_, i) => blob.blockOffset + i)
  if (!blob.blockMap) return { map: [], data: own }
  const blobs = await drive.getBlobs()
  return { map: own, data: (await blobs.getBlockMap(blob)).blocks.map((b) => b.index) }
}

// Fetches a share of the payload's data blocks into the local store before any updater runs. The
// map blocks come along: the data blocks cannot be named without them.
async function holdShare(store, key, present) {
  const drive = new Hyperdrive(store.session(), key)
  await drive.ready()
  await drive.update({ wait: true })
  const { data } = await payloadBlocks(drive)
  const held = data.slice(0, Math.floor(data.length * present))
  const blobs = await drive.getBlobs()
  await blobs.core.download({ blocks: held }).done()
  await drive.close()
  return held.length
}

async function download(t, { dedup, present }) {
  const seedStore = new Corestore(tmpDir('update-progress-seed', t))
  const seed = new Hyperdrive(seedStore)
  await seed.ready()
  t.teardown(async () => { await seed.close(); await seedStore.close() })
  await publish(seed, { dedup })
  const { map, data } = await payloadBlocks(seed)

  const dir = tmpDir('update-progress-stage', t)
  const store = new Corestore(path.join(dir, 'pear-runtime', 'corestore'))
  replicate(seedStore, store, t)
  const held = present > 0 ? await holdShare(store, seed.key, present) : 0
  const toFetch = data.length - held + (present > 0 ? 0 : map.length)

  const updater = new PearRuntimeUpdater({
    dir, app: path.join(dir, NAME), bundled: true, updates: true, version: '0.0.1',
    upgrade: `pear://${hid.encode(seed.key)}`, name: NAME, store, delay: 0,
  })
  updater.on('error', (err) => t.fail(`updater error: ${err.message}`))
  t.teardown(async () => { await updater.close(); await store.close() })

  // A later pass over a staged update announces a download with nothing left to fetch: the first
  // pass is the download under test.
  let tracker = null
  let atStart
  const seen = []
  updater.on('updating', () => {
    if (tracker) return
    tracker = trackUpdateDownload(updater.checkout, PREFIX)
    atStart = tracker.fraction()
  })
  updater.on('updating-progress', () => seen.push(tracker.fraction()))
  await updater.ready()
  await updater._debouncedUpdate()
  await waitFor(() => updater.updated, 10000, { label: 'staged' })
  const sizedAt = await tracker.sized
  t.teardown(() => tracker.stop())
  return { tracker, atStart, seen, sizedAt, toFetch }
}

for (const dedup of [false, true]) {
  const shape = dedup ? 'behind a block map' : 'as a plain file'

  test(`a fresh download ${shape} is unknown until sized and ends whole`, { timeout: scaled(60000) }, async (t) => {
    const { tracker, atStart, seen, sizedAt, toFetch } = await download(t, { dedup, present: 0 })
    t.is(atStart, null, 'no fraction before the walk has ended')
    t.is(sizedAt, toFetch, 'the download is every block of the payload')
    t.is(tracker.fraction(), 1, 'and every one of them was counted as it arrived')
    t.ok(seen.every((f) => f === null || (f >= 0 && f <= 1)), 'every reading is unknown or a fraction')
  })

  test(`a download ${shape} resumed half way counts only the rest`, { timeout: scaled(60000) }, async (t) => {
    const { tracker, sizedAt, toFetch } = await download(t, { dedup, present: 0.5 })
    t.is(toFetch, CHUNKS / 2)
    t.is(sizedAt, toFetch, 'the blocks already here are not part of the download')
    t.is(tracker.fraction(), 1)
  })

  test(`a download ${shape} with every block already here is whole at once`, { timeout: scaled(60000) }, async (t) => {
    const { tracker, sizedAt } = await download(t, { dedup, present: 1 })
    t.is(sizedAt, 0)
    t.is(tracker.fraction(), 1)
  })
}
