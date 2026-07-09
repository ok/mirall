import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setupOwnedShare, listRelPaths } from '../helpers/owned.js'
import { initialPublishScan, periodicReconcile, onFsEvent } from '../../src/shared/folders/owned-folders.js'
import { getOwnEntry } from '../../src/shared/shares/share-catalog.js'
import { overlayHashFile } from '../../src/shared/transfer/backends/overlay/overlay-backend.js'

test('initial scan publishes disk files to the catalog; re-scan is a no-op', async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  fs.writeFileSync(path.join(mountPath, 'a.txt'), 'hello')
  fs.writeFileSync(path.join(mountPath, 'b.txt'), 'world')

  const r1 = await initialPublishScan(spaceId, share.id, mountPath, [])
  t.is(r1.uploaded, 2, 'two files uploaded')
  t.is(r1.deleted, 0)
  t.alike(await listRelPaths(share, spaceId), ['a.txt', 'b.txt'])

  const r2 = await initialPublishScan(spaceId, share.id, mountPath, [])
  t.is(r2.uploaded, 0, 'idempotent: nothing re-uploaded')
  t.is(r2.deleted, 0)
})

test('REGRESSION: a missing mount root never deletes catalog entries (no mirror cascade)', async (t) => {
  const { spaceId, share, mountPath, fake } = await setupOwnedShare(t)
  fs.writeFileSync(path.join(mountPath, 'keep.txt'), 'data')
  await initialPublishScan(spaceId, share.id, mountPath, [])
  t.is((await listRelPaths(share, spaceId)).length, 1)

  // user moves/deletes the source folder
  fs.rmSync(mountPath, { recursive: true, force: true })

  const r = await periodicReconcile(spaceId, share.id, mountPath, [])
  t.is(r.skipped, 'mount-point-gone', 'reconcile bails out')
  t.is(r.deleted, 0, 'ZERO deletions issued')
  t.is((await listRelPaths(share, spaceId)).length, 1, 'published snapshot preserved')
  t.is(fake.lastStatus(share.id), 'mount-point-gone', 'status event emitted')
})

test('REGRESSION: unlink while the mount root is gone deletes nothing', async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  const abs = path.join(mountPath, 'keep.txt')
  fs.writeFileSync(abs, 'data')
  await initialPublishScan(spaceId, share.id, mountPath, [])

  // root vanishes (rename/move), then chokidar fires unlink for the file
  fs.rmSync(mountPath, { recursive: true, force: true })
  await onFsEvent(spaceId, share.id, 'unlink', 'keep.txt', abs)

  t.is((await listRelPaths(share, spaceId)).length, 1, 'unlink dropped — entry preserved')
})

test('a genuine single-file delete (root present) DOES remove the entry', async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  const abs = path.join(mountPath, 'gone.txt')
  fs.writeFileSync(abs, 'bye')
  await initialPublishScan(spaceId, share.id, mountPath, [])
  t.is((await listRelPaths(share, spaceId)).length, 1)

  fs.rmSync(abs)                         // delete just the file; root still present
  await onFsEvent(spaceId, share.id, 'unlink', 'gone.txt', abs)
  t.is((await listRelPaths(share, spaceId)).length, 0, 'real delete propagated')
})

test('published catalog entry carries the overlay content hash', async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  const abs = path.join(mountPath, 'a.txt')
  fs.writeFileSync(abs, 'hello world')
  await initialPublishScan(spaceId, share.id, mountPath, [])
  const entry = await getOwnEntry(spaceId, share.id, 'a.txt')
  t.is(entry.contentHash, await overlayHashFile(abs), 'catalog entry hash equals the overlay content hash')
})
