import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setupOwnedShare } from '../helpers/owned.js'
import { getStore } from '../../src/shared/core/store.js'
import { getOwnEntry } from '../../src/shared/shares/share-catalog.js'
import { getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { overlayBackend } from '../../src/shared/transfer/backends/overlay/index.js'
import { getStorageInfo, freeSpace } from '../../src/shared/storage/storage.js'

// REGRESSION (FIX-148: storage numbers were a residual that hid real usage, and the
// old "Clean up" relabeled bytes instead of freeing them / could delete the index).
test('getStorageInfo reports measured categories; free-space reclaims and keeps the index', async (t) => {
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
  const res = await freeSpace()
  t.is(typeof res.freedBytes, 'number', 'free-space reports freed bytes')
  t.ok(await getOverlay()._index.hasChunkMapByHash(liveHash), 'the served map survives free-space')
  const after = await getStorageInfo()
  t.ok(after.indexBytes < before.indexBytes, `index shrank (before=${before.indexBytes} after=${after.indexBytes})`)

  // A second free-space on a now-clean index must be a no-op: no churn, no growth.
  await freeSpace()
  const after2 = await getStorageInfo()
  t.ok(await getOverlay()._index.hasChunkMapByHash(liveHash), 'the served map survives a second free-space')
  t.is(after2.indexBytes, after.indexBytes, 'a second free-space does not grow the clean index')
})
