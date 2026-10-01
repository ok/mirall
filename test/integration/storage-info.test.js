import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { freshPeer } from '../helpers/store.js'
import { getStore } from '../../src/shared/core/store.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { upsertMember } from '../../src/shared/spaces/space.js'
import { advertise, tombstone } from '../../src/shared/shares/own-catalog.js'
import { initDownloads } from '../../src/shared/transfer/files.js'
import { addFile } from '../../src/shared/transfer/file-listing.js'
import { getStorageInfo } from '../../src/shared/storage/storage.js'

const partsSum = (info) => info.spaces.reduce((n, s) => n + s.ownCatalogBytes + s.memberCatalogBytes, 0)
  + info.indexBytes + info.activityLogBytes + info.downloadHistoryBytes + info.historyBytes + info.otherBytes

// Other is the remainder, so the parts meet the total exactly unless the estimates overshoot it.
function assertSumsToTotal(t, info) {
  if (info.otherBytes > 0) t.is(partsSum(info), info.totalDiskUsage, 'the measured parts and other sum to the on-disk total')
  else t.ok(partsSum(info) >= info.totalDiskUsage, 'the estimates overshoot the total, and other is 0')
}

const rowOf = (info, spaceId) => info.spaces.find((s) => s.spaceId === spaceId)

async function settled() {
  await getStore().storage.db.flush()
  return getStorageInfo()
}

// A loose file is served in place, so adding one moves the metadata only.
test('the breakdown sums to the on-disk total and never counts a shared file twice', async (t) => {
  const { tmpDir } = await freshPeer(t)
  await initDownloads()
  const space = await createSpace('Aurora')
  const before = await getStorageInfo()

  const FILE = 4 * 1024 * 1024
  const src = path.join(tmpDir('src'), 'big.bin')
  fs.writeFileSync(src, Buffer.alloc(FILE, 7))
  await addFile(space.spaceId, src, 'big.bin')

  const info = await settled()
  t.absent('dbBytes' in info, 'no unexplained database residual')
  assertSumsToTotal(t, info)
  t.ok(rowOf(info, space.spaceId), 'the space has a row')
  t.is(rowOf(info, space.spaceId).name, 'Aurora')
  t.ok(info.totalDiskUsage - before.totalDiskUsage < FILE / 2, 'the shared file is not copied into app storage')
})

// REGRESSION (FIX-399: catalog churn was reported as an unexplained residual): republishing and
// tombstoning entries appends to the own catalog on every write, so its growth must show on that
// space's row, not in "other", and not on another space's row.
test('catalog churn is attributed to its space', async (t) => {
  await freshPeer(t)
  const busy = await createSpace('Busy')
  const quiet = await createSpace('Quiet')
  const before = await settled()

  const FILES = 400
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < FILES; i++) {
      await advertise(busy.spaceId, 'share-1', 'renders/frame-' + i + '.exr', { size: 1000 + round, mtime: 1_700_000_000_000 + round, contentHash: 'ab'.repeat(32) })
    }
  }
  for (let i = 0; i < FILES; i++) await tombstone(busy.spaceId, 'share-1', 'renders/frame-' + i + '.exr')
  const after = await settled()

  const grew = rowOf(after, busy.spaceId).ownCatalogBytes - rowOf(before, busy.spaceId).ownCatalogBytes
  const totalGrew = after.totalDiskUsage - before.totalDiskUsage
  t.ok(grew > 100_000, `the busy space's own catalog grew (${grew} bytes)`)
  t.ok(grew >= totalGrew / 2, `most of the store's growth is on that row (${grew} of ${totalGrew})`)
  t.ok(after.otherBytes - before.otherBytes < grew, 'other did not absorb it')
  t.is(rowOf(after, quiet.spaceId).ownCatalogBytes, rowOf(before, quiet.spaceId).ownCatalogBytes, 'the other space is unaffected')
  t.is(after.spaces[0].spaceId, busy.spaceId, 'the growing space is listed first')
  assertSumsToTotal(t, after)
})

// A member's catalog is replicated into this device's store; its bytes belong to the space the
// member record is in, measured from what is on disk.
test('a member\'s catalog core is attributed to the space as a member catalog', async (t) => {
  await freshPeer(t)
  const space = await createSpace('Aurora')
  const keyPair = crypto.keyPair()
  const core = getStore().get({ keyPair })
  await core.ready()
  for (let i = 0; i < 2000; i++) await core.append(b4a.alloc(200, i % 256))
  const catalogKey = b4a.toString(core.key, 'hex')
  t.teardown(() => core.close())
  await upsertMember(space.spaceId, { publicKey: b4a.toString(crypto.keyPair().publicKey, 'hex'), looseCatalogKey: catalogKey })

  const info = await settled()
  const row = rowOf(info, space.spaceId)
  t.ok(row.memberCatalogBytes > 200_000, `member catalog bytes measured (${row.memberCatalogBytes})`)
  t.ok(row.memberCatalogBytes < 2000 * 200 * 3, 'measured from disk, within a small multiple of the data')
})
