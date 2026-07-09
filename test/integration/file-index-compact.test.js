import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setupOwnedShare } from '../helpers/owned.js'
import { getStore } from '../../src/shared/core/store.js'
import { getOwnEntry } from '../../src/shared/shares/share-catalog.js'
import { getOverlay, getOverlayLocalByteLength } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { overlayBackend } from '../../src/shared/transfer/backends/overlay/index.js'
import { compactOverlayIndex } from '../../src/shared/transfer/backends/overlay/overlay-backend.js'

// REGRESSION (FIX-147: the append-only file-index never shrank — each edit left a
// superseded content-addressed chunk map on disk that nothing ever reclaimed).
// Disk reclaim of blob-separated maps is proven at scale by leave-frees-disk; here
// the assertion is the index's logical size, which shrinks as dead maps are dropped.
test('compacting the overlay index drops superseded maps and frees disk', async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  const abs = path.join(mountPath, 'churn.bin')

  const deadHashes = []
  let liveHash = null
  for (let v = 1; v <= 6; v++) {
    fs.writeFileSync(abs, Buffer.alloc(2 * 1024 * 1024, v)) // distinct content ⇒ distinct hash
    const future = new Date(Date.now() + v * 5000)
    fs.utimesSync(abs, future, future)
    await overlayBackend.publishAdd(spaceId, share, 'churn.bin', abs)
    if (liveHash) deadHashes.push(liveHash)
    liveHash = (await getOwnEntry(spaceId, share.id, 'churn.bin')).contentHash
  }
  await getStore().storage.db.flush()

  const fi = getOverlay()._index
  t.ok(await fi.hasChunkMapByHash(liveHash), 'the current map is present')
  t.ok(await fi.hasChunkMapByHash(deadHashes[0]), 'a superseded map is present before compaction')
  const before = await getOverlayLocalByteLength()

  const res = await compactOverlayIndex()
  t.ok(res.compacted, 'compaction ran')

  const fi2 = getOverlay()._index
  t.ok(await fi2.hasChunkMapByHash(liveHash), 'the served map survives compaction')
  for (const h of deadHashes) t.absent(await fi2.hasChunkMapByHash(h), 'a superseded map is dropped')
  const after = await getOverlayLocalByteLength()
  t.ok(after < before, `index shrank (before=${before} after=${after})`)
})
