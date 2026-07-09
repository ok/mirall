import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setupOwnedShare } from '../helpers/owned.js'
import { getOwnEntry } from '../../src/shared/shares/share-catalog.js'
import { getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { overlayBackend } from '../../src/shared/transfer/backends/overlay/index.js'

// REGRESSION (FIX-146: removing a shared file left its chunk map in the file-index
// forever — the FileIndex delete methods had no callers, so the index only grew).
test('removing a shared file evicts its chunk map; a shared hash survives', async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  const bytes = Buffer.alloc(2 * 1024 * 1024, 9) // >= 1 MiB so the chunk map is persisted
  const a = path.join(mountPath, 'a.bin'); fs.writeFileSync(a, bytes)
  const b = path.join(mountPath, 'b.bin'); fs.writeFileSync(b, bytes) // identical content → same hash

  await overlayBackend.publishAdd(spaceId, share, 'a.bin', a)
  await overlayBackend.publishAdd(spaceId, share, 'b.bin', b)
  const hash = (await getOwnEntry(spaceId, share.id, 'a.bin')).contentHash
  const fi = getOverlay()._index
  t.ok(await fi.hasChunkMapByHash(hash), 'chunk map present after publish')

  await overlayBackend.publishDelete(spaceId, share, 'a.bin')
  t.ok(await fi.hasChunkMapByHash(hash), 'map kept while b.bin still references the hash')

  await overlayBackend.publishDelete(spaceId, share, 'b.bin')
  t.absent(await fi.hasChunkMapByHash(hash), 'map evicted once no path references the hash')
  t.absent(await fi.getFile('/mir/' + hash), 'the /mir register entry is evicted too')
})
