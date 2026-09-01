import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setupOwnedShare } from '../helpers/owned.js'
import { getStore } from '../../src/shared/core/store.js'
import { getOwnEntry } from '../../src/shared/shares/share-catalog.js'
import { getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { overlayBackend } from '../../src/shared/transfer/backends/overlay/index.js'
import { getStorageInfo } from '../../src/shared/storage/storage.js'
import { compactOverlayIndex } from '../../src/shared/transfer/backends/overlay/overlay-backend.js'

// REGRESSION (FIX-148: storage numbers were a residual that hid real usage, and the old
// "Clean up" relabeled bytes instead of freeing them / could delete the index). The action is
// gone; compaction now runs on the sweeps tick, and the guarantee it has to keep is unchanged —
// it must shrink the index and must never drop a chunk map that is still served.
test('getStorageInfo reports measured categories; compaction shrinks the index and keeps served maps', async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  const abs = path.join(mountPath, 'churn.bin')
  let liveHash = null
  for (let v = 1; v <= 5; v++) {
    fs.writeFileSync(abs, Buffer.alloc(2 * 1024 * 1024, v))
    const future = new Date(Date.now() + v * 5000); fs.utimesSync(abs, future, future)
    await overlayBackend.publishAdd(spaceId, share, 'churn.bin', abs)
    liveHash = (await getOwnEntry(spaceId, share.id, 'churn.bin')).contentHash
  }
  await getStore().storage.db.flush()

  const info = await getStorageInfo()
  t.ok(info.indexBytes > 0, 'the shared-file index is measured, not lumped into a residual')
  t.is(typeof info.dbBytes, 'number', 'db bytes present')
  t.absent('otherBytes' in info, 'the residual otherBytes field is gone')

  const before = await getStorageInfo()
  t.ok((await compactOverlayIndex()).compacted, 'compaction ran')
  t.ok(await getOverlay()._index.hasChunkMapByHash(liveHash), 'the served map survives compaction')
  const after = await getStorageInfo()
  t.ok(after.indexBytes < before.indexBytes, `index shrank (before=${before.indexBytes} after=${after.indexBytes})`)

  // A second pass on a now-clean index must be a no-op: no churn, no growth. It runs on a timer
  // now, so "idempotent" stopped being a nicety.
  await compactOverlayIndex()
  const after2 = await getStorageInfo()
  t.ok(await getOverlay()._index.hasChunkMapByHash(liveHash), 'the served map survives a second pass')
  t.is(after2.indexBytes, after.indexBytes, 'a second pass does not grow the clean index')
})
