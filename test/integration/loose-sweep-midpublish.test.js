import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space.js'
import { advertise, getOwnEntry } from '../../src/shared/shares/share-catalog.js'
import { getRuntimeConfig, setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { serveIndex } from '../../src/shared/transfer/backends/overlay/overlay-serve-index.js'
import { initOverlay, teardownOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { initDownloads } from '../../src/shared/transfer/files.js'
import { initPendingTransfers } from '../../src/shared/transfer/pending-transfers.js'
import {
  initLooseOverlay, looseShareFile, sweepLoosePresence,
  LOOSE_SHARE_ID, looseSources,
} from '../../src/shared/transfer/loose-overlay.js'

async function setup (t) {
  const ctx = await freshPeer(t)
  setRuntimeConfig({ ...getRuntimeConfig(), overlayEnabled: true, inPlaceFilesEnabled: true })
  await initDownloads()
  await initPendingTransfers()
  const space = await createSpace('Aurora')
  serveIndex.reset()
  looseSources.clear()
  await initOverlay()
  initLooseOverlay(ctx.fake.ipc)
  t.teardown(async () => {
    serveIndex.reset()
    await teardownOverlay()
    setRuntimeConfig({ ...getRuntimeConfig(), overlayEnabled: false, inPlaceFilesEnabled: false })
  })
  return { ...ctx, spaceId: space.spaceId }
}

// REGRESSION (FIX-1: a large loose file vanishes right after a successful share). The
// loose presence sweep ran every 60 s and tombstoned any entry whose owned-source map
// was unset — but markOwnedSource is written only AFTER the multi-minute hash, so a large
// file is advertised-with-null-source for its whole prepare window. Two sweeps would arm
// then queue a tombstone behind the publish's space lock, firing the instant the publish
// finished. A still-preparing entry (no recorded source yet) must survive the sweep.
test('REGRESSION (FIX-1): the sweep does not tombstone a still-preparing loose entry', async (t) => {
  const ctx = await setup(t)
  // Exactly the mid-publish state: advertised with contentHash:null, no owned-source yet.
  await advertise(ctx.spaceId, LOOSE_SHARE_ID, 'big.mp4', { size: 43_000_000_000, mtime: Date.now(), contentHash: null })
  t.ok(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'big.mp4'), 'precondition: advertised (preparing)')

  await sweepLoosePresence() // would arm (first miss)
  await sweepLoosePresence() // would tombstone (second consecutive miss) — the bug

  t.ok(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'big.mp4'), 'a preparing entry (source map not written yet) survives the sweep')
})

// The narrowing must NOT disable the sweep's real purpose: an entry whose RECORDED
// source file genuinely disappears (a missed watcher unlink) is still reclaimed.
test('FIX-1: the sweep still tombstones a shared entry whose recorded source vanished', async (t) => {
  const ctx = await setup(t)
  const abs = path.join(ctx.tmpDir('src'), 'gone.bin')
  fs.writeFileSync(abs, 'data')
  await looseShareFile(ctx.spaceId, abs) // full publish → records the owned source
  t.ok(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'gone.bin'), 'precondition: shared with a recorded source')

  fs.unlinkSync(abs) // source vanishes; no real watcher in-test → the sweep is the backstop

  await sweepLoosePresence() // arm
  await sweepLoosePresence() // tombstone

  t.absent(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'gone.bin'), 'a genuinely-vanished recorded source is reclaimed')
})
