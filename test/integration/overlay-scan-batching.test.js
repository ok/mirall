import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space.js'
import { publishShare, generateShareId } from '../../src/shared/shares/shares.js'
import { getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import { saveOwnedMount } from '../../src/shared/folders/mount-store.js'
import { initialPublishScan } from '../../src/shared/folders/owned-folders.js'
import { ownCatalog, listOwnShare } from '../../src/shared/shares/share-catalog.js'
import { serveIndex } from '../../src/shared/transfer/backends/overlay/overlay-serve-index.js'
import { teardownOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { overlayBackend } from '../../src/shared/transfer/backends/overlay/index.js'
import { initContentBackendOverlay } from '../../src/shared/transfer/backends/overlay/overlay-backend.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'

async function bootOverlay (t) {
  const ctx = await freshPeer(t)
  initContentBackendOverlay(ctx.fake.ipc)
  serveIndex.reset()
  await overlayBackend.init()
  t.teardown(async () => {
    serveIndex.reset()
    await teardownOverlay()
  })
  return ctx
}

async function makeShare (ctx, name) {
  const space = await createSpace(name)
  const share = {
    id: generateShareId(),
    type: 'owned-folder',
    name,
    contentMode: 'overlay',
    owner: getLocalPublicKeyHex(),
    createdAt: Date.now(),
  }
  await publishShare(space.spaceId, share)
  const mountPath = ctx.tmpDir('mount-' + name)
  await saveOwnedMount({ spaceId: space.spaceId, shareId: share.id, mountPath, ignore: [], createdAt: Date.now() })
  return { spaceId: space.spaceId, share, mountPath }
}

function fillFiles (dir, n) {
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(dir, 'f' + String(i).padStart(4, '0') + '.txt'), 'x'.repeat(64))
}

async function scanAppends (share) {
  const bee = await ownCatalog(share.spaceId)
  const before = bee.core.length
  const res = await initialPublishScan(share.spaceId, share.share.id, share.mountPath, [])
  return { res, appends: bee.core.length - before }
}

// REGRESSION (FIX-133: the owner wrote ~2 un-batched catalog puts per file during a scan, flooding
// the consumer with appends and leaving the replicated head perpetually incomplete. A scan now
// batches catalog writes into one atomic head per flush, collapsing the per-file append count.)
test('REGRESSION (FIX-133): batching collapses catalog appends vs the per-file write path', { timeout: 60000 }, async (t) => {
  const ctx = await bootOverlay(t)
  const N = 80

  // Baseline: flush on every op (≈ the pre-batch direct-put path), in its own space/catalog.
  setRuntimeConfig({ ...getRuntimeConfig(), catalogFlushMaxOps: 1, catalogFlushMs: 0 })
  const a = await makeShare(ctx, 'PerFile')
  fillFiles(a.mountPath, N)
  const perFile = await scanAppends(a)

  // Batched: one flush for the whole scan, in its own space/catalog.
  setRuntimeConfig({ ...getRuntimeConfig(), catalogFlushMaxOps: 1000, catalogFlushMs: 999999 })
  const b = await makeShare(ctx, 'Batched')
  fillFiles(b.mountPath, N)
  const batched = await scanAppends(b)

  t.is(perFile.res.uploaded, N, 'per-file scan published all files')
  t.is(batched.res.uploaded, N, 'batched scan published all files')

  let listed = 0
  let withHash = 0
  for await (const e of listOwnShare(b.spaceId, b.share.id)) { listed++; if (e.contentHash) withHash++ }
  t.is(listed, N, 'batched catalog lists every file')
  t.is(withHash, N, 'every entry carries its content hash')

  t.ok(batched.appends < perFile.appends, 'batched ' + batched.appends + ' < per-file ' + perFile.appends + ' appends for ' + N + ' files')
})
