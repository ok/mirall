import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setupOwnedShare } from '../helpers/owned.js'
import {
  initialPublishScan, periodicReconcile, onFsEvent, countFolderFiles,
} from '../../src/shared/folders/owned-folders.js'
import { previewInitialPublishScan } from '../../src/shared/folders/owned-preview.js'
import { collectOwnShare } from '../../src/shared/shares/share-catalog.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'

function writeFiles (dir, n, from = 0) {
  for (let i = from; i < from + n; i++) {
    fs.writeFileSync(path.join(dir, 'f' + String(i).padStart(3, '0') + '.txt'), 'x')
  }
}

function withLimit (t, limit) {
  const saved = getRuntimeConfig()
  t.teardown(() => setRuntimeConfig(saved))
  setRuntimeConfig({ ...saved, maxFilesPerShare: limit })
}

async function catalogTotal (spaceId, shareId) {
  return (await collectOwnShare(spaceId, shareId, 0)).total
}

// The add-folder preview is what the wizard blocks on, so it must carry the verdict — the user
// learns the folder is too large BEFORE committing, not from a truncated list afterwards.
test('the add-folder preview reports the folder total and the over-limit verdict', async (t) => {
  const { spaceId, mountPath } = await setupOwnedShare(t)
  withLimit(t, 10)
  writeFiles(mountPath, 12)

  const preview = await previewInitialPublishScan(spaceId, null, mountPath, [])
  t.is(preview.totalFiles, 12, 'the TRUE folder count (PREVIEW_DETAIL_MAX_FILES caps only the per-file list)')
  t.is(preview.fileLimit, 10)
  t.ok(preview.overFileLimit, 'the wizard has what it needs to refuse')
})

test('a folder at exactly the limit is admitted', async (t) => {
  const { spaceId, mountPath } = await setupOwnedShare(t)
  withLimit(t, 10)
  writeFiles(mountPath, 10)

  const preview = await previewInitialPublishScan(spaceId, null, mountPath, [])
  t.is(preview.totalFiles, 10)
  t.absent(preview.overFileLimit, 'exactly at the limit is not over it')
  t.is(await countFolderFiles(mountPath, []), 10, 'the gate counts the same folder the scan will publish')
})

// REGRESSION (FIX-360): the limit is an ADMISSION gate, not a runtime ceiling. A share admitted at
// the limit that later grows past it must keep publishing every file — silently refusing to publish
// would leave the folder incomplete on every peer, which is a far worse failure than a short list.
// So the publish path (scan, reconcile, watcher add) never consults the limit at all.
test('REGRESSION (FIX-360): growth past the limit keeps publishing — the scan is never gated', async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  withLimit(t, 10)

  writeFiles(mountPath, 10)
  await initialPublishScan(spaceId, share.id, mountPath, [])
  t.is(await catalogTotal(spaceId, share.id), 10, 'admitted at exactly the limit')

  // The folder grows past the limit — via the watcher, and via the periodic reconcile.
  writeFiles(mountPath, 2, 10)
  await onFsEvent(spaceId, share.id, 'add', 'f010.txt', path.join(mountPath, 'f010.txt'))
  t.is(await catalogTotal(spaceId, share.id), 11, 'the 11th file publishes — the watcher is not gated')

  await periodicReconcile(spaceId, share.id, mountPath, [])
  t.is(await catalogTotal(spaceId, share.id), 12, 'the 12th publishes too — the reconcile is not gated')
})

// The same rule from the other side: re-scanning an already-over-limit folder must not tombstone or
// refuse anything. A gated remount/reconcile would break a grown share on the next restart.
test('REGRESSION (FIX-360): re-scanning an over-limit folder publishes it whole, deleting nothing', async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  withLimit(t, 5)
  writeFiles(mountPath, 12)

  await initialPublishScan(spaceId, share.id, mountPath, [])
  t.is(await catalogTotal(spaceId, share.id), 12, 'every file is published, limit notwithstanding')

  const r = await periodicReconcile(spaceId, share.id, mountPath, [])
  t.is(r.deleted, 0, 'the reconcile tombstones nothing')
  t.is(await catalogTotal(spaceId, share.id), 12, 'still whole after a re-scan')
})
