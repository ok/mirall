import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setupOwnedShare, listRelPaths } from '../helpers/owned.js'
import { onFsEvent } from '../../src/shared/folders/owned-folders.js'
import { ignorePathsFor } from '../../src/shared/folders/echo-guard.js'
import { getOwnEntry, ownCatalog } from '../../src/shared/shares/share-catalog.js'
import { overlayHashFile } from '../../src/shared/transfer/backends/overlay/overlay-backend.js'

// onFsEvent is the owner-side publish path for a single watcher event. The
// unlink edge cases live in owned-folder-edge (FIX-4/FIX-5); here we cover the
// add/change branch: republish-on-edit, the hash short-circuit, the echo guard,
// and the stat/hash skips. Overlay serves straight from the source, so the
// published state is the catalog entry's content hash (no drive bytes to read).

const publishedHash = async (ctx, rel) =>
  (await getOwnEntry(ctx.spaceId, ctx.share.id, rel))?.contentHash || null

test('change republishes edited content', async (t) => {
  const ctx = await setupOwnedShare(t)
  const abs = path.join(ctx.mountPath, 'doc.txt')
  fs.writeFileSync(abs, 'v1')
  await onFsEvent(ctx.spaceId, ctx.share.id, 'add', 'doc.txt', abs)
  t.is(await publishedHash(ctx, 'doc.txt'), await overlayHashFile(abs), 'v1 published')

  fs.writeFileSync(abs, 'v2-edited')
  await onFsEvent(ctx.spaceId, ctx.share.id, 'change', 'doc.txt', abs)
  t.is(await publishedHash(ctx, 'doc.txt'), await overlayHashFile(abs), 'the edit was republished')
})

test('change is a no-op when content is unchanged (hash short-circuit)', async (t) => {
  const ctx = await setupOwnedShare(t)
  const abs = path.join(ctx.mountPath, 'doc.txt')
  fs.writeFileSync(abs, 'stable')
  await onFsEvent(ctx.spaceId, ctx.share.id, 'add', 'doc.txt', abs)
  const published = await publishedHash(ctx, 'doc.txt')
  const lenBefore = (await ownCatalog(ctx.spaceId)).core.length

  await onFsEvent(ctx.spaceId, ctx.share.id, 'change', 'doc.txt', abs)   // same bytes, same size+mtime
  t.is(await publishedHash(ctx, 'doc.txt'), published, 'unchanged content keeps the same catalog hash')
  // The hash being equal is not enough — identical bytes always hash the same. Prove the
  // size+mtime short-circuit actually SKIPPED the re-advertise: no new append to the catalog.
  t.is((await ownCatalog(ctx.spaceId)).core.length, lenBefore, 'no redundant catalog re-advertise on an unchanged change')
})

test('a path inside the echo-guard window is skipped (our own write does not loop)', async (t) => {
  const ctx = await setupOwnedShare(t)
  const abs = path.join(ctx.mountPath, 'echo.txt')
  fs.writeFileSync(abs, 'v1')
  await onFsEvent(ctx.spaceId, ctx.share.id, 'add', 'echo.txt', abs)
  const v1Hash = await publishedHash(ctx, 'echo.txt')

  // Simulate a write Mirall itself made: guard the path, then the resulting
  // change event must be ignored (and the guard consumed).
  fs.writeFileSync(abs, 'v2')
  ignorePathsFor(ctx.share.id).add(abs)
  await onFsEvent(ctx.spaceId, ctx.share.id, 'change', 'echo.txt', abs)
  t.is(await publishedHash(ctx, 'echo.txt'), v1Hash, 'guarded write was not republished')
  t.absent(ignorePathsFor(ctx.share.id).has(abs), 'guard entry consumed')
})

test('a non-file path and a missing path are not published', async (t) => {
  const ctx = await setupOwnedShare(t)
  const dir = path.join(ctx.mountPath, 'adir')
  fs.mkdirSync(dir)
  await onFsEvent(ctx.spaceId, ctx.share.id, 'add', 'adir', dir)
  await onFsEvent(ctx.spaceId, ctx.share.id, 'add', 'missing.txt', path.join(ctx.mountPath, 'missing.txt'))
  t.alike(await listRelPaths(ctx.share, ctx.spaceId), [], 'neither a directory nor a missing path is published')
})
