import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { initDownloads } from '../../src/shared/transfer/files.js'
import { addFile } from '../../src/shared/transfer/file-listing.js'
import { getStorageInfo } from '../../src/shared/storage/storage.js'

// A loose file is served in place, so adding one moves the metadata only; the two measured parts
// always sum to the on-disk total.
test('the breakdown sums to the on-disk total and never counts a shared file twice', async (t) => {
  const { tmpDir } = await freshPeer(t)
  await initDownloads()
  const space = await createSpace('Aurora')
  const before = await getStorageInfo()

  const FILE = 4 * 1024 * 1024
  const src = path.join(tmpDir('src'), 'big.bin')
  fs.writeFileSync(src, Buffer.alloc(FILE, 7))
  await addFile(space.spaceId, src, 'big.bin')

  const info = await getStorageInfo()
  t.absent('spaces' in info, 'no per-space rows')
  t.is(info.indexBytes + info.dbBytes, info.totalDiskUsage, 'index + database = on-disk total')
  t.ok(info.totalDiskUsage - before.totalDiskUsage < FILE / 2, 'the shared file is not copied into app storage')
})
