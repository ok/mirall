import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { getStoragePath } from '../../src/shared/core/store.js'
import { createForeignMount } from '../../src/shared/folders/mount-store.js'
import { getStorageInfo } from '../../src/shared/storage/storage.js'
import { measureHistory, freeUpStorage } from '../../src/shared/storage/storage-history.js'
import { REWRITE_STATE_FILE } from '../../src/shared/storage/local-bee-rewrite.js'

const PATHS = Array.from({ length: 1494 }, (_, i) => `Folder ${i % 40}/file-${i}.jpg`)

// Each put carries the whole record and differs from the one before, so the bee keeps every copy.
async function repeatMirrorRecord(times) {
  for (let i = 0; i < times; i++) {
    await createForeignMount({ spaceId: 's1', shareId: 'm1', syncedPaths: PATHS, status: 'synced', tick: i % 2 })
  }
}

test('replaced records are measured, kept for the next read, and taken out of other', async (t) => {
  await freshPeer(t)
  await repeatMirrorRecord(100)
  const before = await getStorageInfo()
  t.is(before.historyMeasuredAt, null, 'nothing measured yet')
  t.is(before.historyBytes, 0)

  const history = await measureHistory()
  const mounts = history.bees.find((b) => b.name === 'mounts-meta')
  t.ok(mounts.historyBytes > 3e6, 'the mount records hold history: ' + mounts.historyBytes)
  t.ok(mounts.rewritable, 'and enough for a requested rewrite')

  const info = await getStorageInfo()
  t.is(info.historyMeasuredAt, history.measuredAt, 'the measurement is kept for the next read')
  t.ok(info.historyBytes >= mounts.historyBytes, 'the row carries it')
  t.ok(info.reclaimableBytes >= mounts.historyBytes, 'and Free up counts it')
  t.ok(info.folderBytes >= info.totalDiskUsage, 'the data folder holds the store')
  t.is(info.folderPath, path.dirname(info.storagePath))
  t.is(info.freeUpMinBytes, 100 * 1000 * 1000, 'the default free-up threshold')
})

test('Free up asks the next boot to rewrite the bees over the bar', async (t) => {
  await freshPeer(t)
  await repeatMirrorRecord(100)
  const result = await freeUpStorage()
  t.ok(result.restartRequired, 'a restart runs the rewrite')
  t.ok(result.requested.includes('mounts-meta'), 'the mount records are requested')
  const state = JSON.parse(fs.readFileSync(path.join(getStoragePath(), REWRITE_STATE_FILE)))
  t.ok(state.requested.includes('mounts-meta'), 'the request is on disk for the next boot')
})

test('Free up with nothing to rewrite needs no restart', async (t) => {
  await freshPeer(t)
  t.alike(await freeUpStorage(), { restartRequired: false, requested: [] })
})

test('concurrent measurements share one pass', async (t) => {
  await freshPeer(t)
  const [a, b] = await Promise.all([measureHistory(), measureHistory()])
  t.is(a, b)
})
