import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { getRuntimeConfig, setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { createSpace } from '../../src/shared/spaces/space.js'
import { getOwnEntry } from '../../src/shared/shares/share-catalog.js'
import { serveIndex } from '../../src/shared/transfer/backends/overlay/overlay-serve-index.js'
import { getOverlay, initOverlay, teardownOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { initContentBackendOverlay, _resetContentBackendOverlay, compactOverlayIndex } from '../../src/shared/transfer/backends/overlay/overlay-backend.js'
import { initLooseOverlay, _resetLooseOverlay, LOOSE_SHARE_ID } from '../../src/shared/transfer/loose-overlay.js'
import { initDownloads, addFile } from '../../src/shared/transfer/files.js'
import { initPendingTransfers } from '../../src/shared/transfer/pending-transfers.js'

// REGRESSION (FIX-149: compaction's "served" set was built only from readOwnShares
// (folder shares), so loose single-file shares were treated as unserved and their
// chunk maps were dropped — a shared file re-chunked on its next download).
test('Free up space keeps a still-shared loose file’s chunk map', async (t) => {
  const ctx = await freshPeer(t)
  setRuntimeConfig({ ...getRuntimeConfig(), overlayEnabled: true, inPlaceFilesEnabled: true })
  await initDownloads()
  await initPendingTransfers()
  serveIndex._reset()
  await initOverlay()
  initContentBackendOverlay(ctx.fake.ipc)
  initLooseOverlay(ctx.fake.ipc)
  t.teardown(async () => {
    _resetLooseOverlay(); _resetContentBackendOverlay(); serveIndex._reset(); await teardownOverlay()
    setRuntimeConfig({ ...getRuntimeConfig(), overlayEnabled: false, inPlaceFilesEnabled: false })
  })
  const space = await createSpace('Aurora')

  const abs = path.join(ctx.tmpDir('src'), 'big.bin')
  fs.writeFileSync(abs, Buffer.alloc(2 * 1024 * 1024, 4)) // >= 1 MiB so its chunk map persists
  await addFile(space.spaceId, abs, 'big.bin', 2 * 1024 * 1024, ctx.fake.ipc)
  const looseHash = (await getOwnEntry(space.spaceId, LOOSE_SHARE_ID, 'big.bin')).contentHash
  const fi = getOverlay()._index
  t.ok(looseHash && await fi.hasChunkMapByHash(looseHash), 'the loose file has a persisted chunk map')

  // A dead map for content nobody serves, so compaction actually runs the rebuild.
  await fi.putChunkMapByHash('deadfeed', [{ hash: 'x', offset: 0, length: 10 }])
  t.ok(await fi.hasChunkMapByHash('deadfeed'), 'precondition: a droppable map exists')

  const res = await compactOverlayIndex()
  t.ok(res.compacted, 'compaction ran (there was a dead map to drop)')

  const fi2 = getOverlay()._index
  t.ok(await fi2.hasChunkMapByHash(looseHash), 'the still-shared loose file’s map SURVIVES compaction')
  t.absent(await fi2.hasChunkMapByHash('deadfeed'), 'the genuinely-dead map is dropped')
})
