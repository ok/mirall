import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import b4a from 'b4a'
import { freshPeer } from '../helpers/store.js'
import { createSpace, getDrive } from '../../src/shared/spaces/space.js'
import {
  initDownloads,
  addFile,
  removeFile,
  markDownloaded,
  getDownloadedPath,
  getOwnedSourcePath,
  resolveRevealTarget,
  isDownloadedFile,
  markVerified,
  getVerifiedHash,
  cleanupDownloadHistory,
  listDownloadClaimsForShare,
  listVerifiedForShare,
  pruneDownloadClaims,
  verdictForClaim,
} from '../../src/shared/transfer/files.js'
import { initPendingTransfers, recordPending, getPendingFor } from '../../src/shared/transfer/pending-transfers.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { setSpaceDownloadRoot } from '../../src/shared/core/paths.js'
import { initOverlay, teardownOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { initContentBackendOverlay } from '../../src/shared/transfer/backends/overlay/overlay-backend.js'

async function setup (t) {
  const ctx = await freshPeer(t)
  setRuntimeConfig({ ...getRuntimeConfig(), overlayEnabled: true })
  await initOverlay()
  initContentBackendOverlay(ctx.fake.ipc)
  t.teardown(async () => { await teardownOverlay() })
  await initDownloads()
  await initPendingTransfers()
  const space = await createSpace('Aurora')
  return { ...ctx, spaceId: space.spaceId, drive: getDrive(space.spaceId) }
}

// Dragging an unsaved screenshot / Photo Booth capture into the drop zone gives
// us an ephemeral temp path that vanishes once the source app finishes. addFile
// used to stream it anyway, publishing a file whose source promptly disappeared
// (so "Open in folder" later just opened an empty Downloads). Reject it up front.
test('REGRESSION (FIX-DROP-2): addFile rejects an ephemeral macOS promised-file source', async (t) => {
  const { spaceId, drive, tmpDir } = await setup(t)
  const dir = path.join(tmpDir('drop'), 'TemporaryItems')
  fs.mkdirSync(dir, { recursive: true })
  const ephemeral = path.join(dir, 'Screenshot.png')
  fs.writeFileSync(ephemeral, 'transient bytes')

  await t.exception(
    () => addFile(spaceId, ephemeral, 'Screenshot.png', 15, null),
    /not saved on disk/,
    'rejects a source under TemporaryItems even though it momentarily exists',
  )
  t.absent(await drive.entry('/Screenshot.png'), 'nothing was published to the drive')
})

test('REGRESSION (FIX-DROP-2): addFile rejects a source that is not on disk', async (t) => {
  const { spaceId, drive, tmpDir } = await setup(t)
  const missing = path.join(tmpDir('src'), 'never-existed.txt')

  await t.exception(
    () => addFile(spaceId, missing, 'never-existed.txt', 0, null),
    /not saved on disk/,
    'rejects a path with no file behind it',
  )
  t.absent(await drive.entry('/never-existed.txt'), 'nothing was published to the drive')
})

test('removeFile clears + tombstones the drive entry', async (t) => {
  const { spaceId, drive, tmpDir } = await setup(t)
  const src = path.join(tmpDir('src'), 'gone.txt')
  fs.writeFileSync(src, 'bye')
  await addFile(spaceId, src, 'gone.txt', 3, null)

  await removeFile(spaceId, '/gone.txt')

  t.absent(await drive.entry('/gone.txt'), 'entry removed')
})

// Unsharing must only remove the file from the space (the drive entry + download
// record). It must NEVER touch the user's local source file on disk — that would
// be silent destruction of the user's original.
test('removeFile leaves the user’s local source file untouched', async (t) => {
  const { spaceId, drive, tmpDir } = await setup(t)
  const src = path.join(tmpDir('src'), 'keep-local.txt')
  fs.writeFileSync(src, 'my original')
  await addFile(spaceId, src, 'keep-local.txt', 11, null)

  await removeFile(spaceId, '/keep-local.txt')

  t.absent(await drive.entry('/keep-local.txt'), 'precondition: drive entry removed')
  t.ok(fs.existsSync(src), 'the user’s local source file still exists')
  t.is(fs.readFileSync(src, 'utf8'), 'my original', 'and its content is intact')
})

// "Open in folder" on a file you OWN used to fall back to <Downloads>/<name>,
// which doesn't exist (you never downloaded it) — so Finder opened an empty
// Downloads folder, making the file look like it wasn't on disk. addFile now
// records the original source so reveal points at the real file.
test('REGRESSION (FIX-DROP-3): addFile remembers the owned source for reveal', async (t) => {
  const { spaceId, tmpDir } = await setup(t)
  const src = path.join(tmpDir('src'), 'owned.txt')
  fs.writeFileSync(src, 'mine')

  await addFile(spaceId, src, 'owned.txt', 4, null)

  t.is(await getOwnedSourcePath(spaceId, '/owned.txt'), src, 'source path recorded under the drive name')
  t.is(await resolveRevealTarget(spaceId, '/owned.txt'), src, 'reveal targets the real source, not Downloads')
})

test('REGRESSION (FIX-DROP-3): removing an owned file clears its source record', async (t) => {
  const { spaceId, downloads, tmpDir } = await setup(t)
  const src = path.join(tmpDir('src'), 'owned.txt')
  fs.writeFileSync(src, 'mine')
  await addFile(spaceId, src, 'owned.txt', 4, null)

  await removeFile(spaceId, '/owned.txt')

  t.is(await getOwnedSourcePath(spaceId, '/owned.txt'), null, 'source record cleared')
  // With no record, reveal falls back to <Downloads>/<basename>.
  t.is(await resolveRevealTarget(spaceId, '/owned.txt'), path.join(downloads, 'owned.txt'), 'falls back to Downloads')
})

test('resolveRevealTarget prefers a downloaded landed path over the owned source', async (t) => {
  const { spaceId, tmpDir } = await setup(t)
  const src = path.join(tmpDir('src'), 'dup.txt')
  fs.writeFileSync(src, 'data')
  await addFile(spaceId, src, 'dup.txt', 4, null)
  await markDownloaded(spaceId, '/dup.txt', '/Users/me/Downloads/dup (1).txt')

  t.is(
    await resolveRevealTarget(spaceId, '/dup.txt'),
    '/Users/me/Downloads/dup (1).txt',
    'downloaded path wins when both are present',
  )
})

test('markDownloaded records the actual landed path for reveal/status', async (t) => {
  const { spaceId, tmpDir } = await setup(t)
  const dir = tmpDir('dl')
  setSpaceDownloadRoot(spaceId, dir)
  const landed = path.join(dir, 'remote (1).txt')
  fs.writeFileSync(landed, 'bytes')
  await markDownloaded(spaceId, '/remote.txt', landed)
  t.is(await getDownloadedPath(spaceId, '/remote.txt'), landed)
  t.ok(await isDownloadedFile(spaceId, '/remote.txt'), 'downloaded while the file is on disk')
})

// FIX-21 — "downloaded" must track bytes actually on disk, not a claim that
// outlives them. A landed file that's since been deleted reverts to not-downloaded
// (and the stale claim is pruned), so a re-share never shows a phantom copy.
test('isDownloadedFile drops the claim once the landed file is gone', async (t) => {
  const { spaceId, tmpDir } = await setup(t)
  const dir = tmpDir('dl')
  setSpaceDownloadRoot(spaceId, dir)
  const landed = path.join(dir, 'r.txt')
  fs.writeFileSync(landed, 'bytes')
  await markDownloaded(spaceId, '/r.txt', landed, { hash: 'h1' })
  t.ok(await isDownloadedFile(spaceId, '/r.txt', 'h1'), 'present + hash match → downloaded')

  fs.unlinkSync(landed)
  t.absent(await isDownloadedFile(spaceId, '/r.txt', 'h1'), 'file gone → not downloaded')
  t.is(await getDownloadedPath(spaceId, '/r.txt'), null, 'stale claim pruned')
})

// A re-share that replaces the file with different content (same path) must not
// be reported as the old, already-downloaded copy.
test('isDownloadedFile drops the claim when upstream content changed', async (t) => {
  const { spaceId, tmpDir } = await setup(t)
  const landed = path.join(tmpDir('dl'), 's.txt')
  fs.writeFileSync(landed, 'old')
  await markDownloaded(spaceId, '/s.txt', landed, { hash: 'old-hash' })
  t.absent(await isDownloadedFile(spaceId, '/s.txt', 'new-hash'), 'hash mismatch → not downloaded')
  t.is(await getDownloadedPath(spaceId, '/s.txt'), null, 'stale claim pruned')
})

// The "verified" marker backs the file-row check: an overlay download whose
// content hash was confirmed on landing records it here so the row can show
// "verified" without re-hashing the file.
test('verified marker round-trips and is cleared on space cleanup', async (t) => {
  const { spaceId } = await setup(t)
  const key = 'share1|docs/a.bin'

  t.is(await getVerifiedHash(spaceId, key), null, 'absent before marking')
  await markVerified(spaceId, key, 'oid-AAA')
  t.is(await getVerifiedHash(spaceId, key), 'oid-AAA', 'returns the verified hash')

  await markVerified(spaceId, key, 'oid-BBB')
  t.is(await getVerifiedHash(spaceId, key), 'oid-BBB', 're-marking updates the hash')

  await cleanupDownloadHistory(spaceId)
  t.is(await getVerifiedHash(spaceId, key), null, 'cleared with the space download history')
})

// The share listing reads every row's claim from one range scan instead of a point read per row,
// so the scan must answer exactly what the point reads answered — no sibling share's keys, and
// nothing retained for a row the listing will not render.
test('listDownloadClaimsForShare scans one share and never a sibling', async (t) => {
  const { spaceId, tmpDir } = await setup(t)
  const dir = tmpDir('dl')
  for (const drivePath of ['/Docs/a.txt', '/Docs/sub/b.txt', '/Docs2/c.txt', '/Doc/d.txt']) {
    const landed = path.join(dir, drivePath.split('/').join('_'))
    fs.writeFileSync(landed, 'bytes')
    await markDownloaded(spaceId, drivePath, landed, { hash: 'h' })
  }

  const claims = await listDownloadClaimsForShare(spaceId, 'Docs')
  t.alike([...claims.keys()].sort(), ['/Docs/a.txt', '/Docs/sub/b.txt'], 'only the named share, nested paths included')
  t.is(claims.get('/Docs/a.txt').hash, 'h', 'the whole record comes back, not just the path')

  const other = await listDownloadClaimsForShare('other-space', 'Docs')
  t.is(other.size, 0, 'the scan is scoped to the space as well as the share')
})

test('the keep filter bounds retention without narrowing the scan', async (t) => {
  const { spaceId, tmpDir } = await setup(t)
  const landed = path.join(tmpDir('dl'), 'k.txt')
  fs.writeFileSync(landed, 'bytes')
  await markDownloaded(spaceId, '/Docs/keep.txt', landed, { hash: 'h1' })
  await markDownloaded(spaceId, '/Docs/drop.txt', landed, { hash: 'h2' })
  await markVerified(spaceId, 'sh1|keep.txt', 'h1')
  await markVerified(spaceId, 'sh1|drop.txt', 'h2')

  const claims = await listDownloadClaimsForShare(spaceId, 'Docs', { keep: new Set(['/Docs/keep.txt']) })
  t.alike([...claims.keys()], ['/Docs/keep.txt'])

  const verified = await listVerifiedForShare(spaceId, 'sh1', { keep: new Set(['keep.txt']) })
  t.alike([...verified.keys()], ['keep.txt'])
  t.is((await listVerifiedForShare(spaceId, 'sh1')).size, 2, 'no keep is the unfiltered scan the storage summary relies on')
})

test('pruneDownloadClaims removes exactly the listed keys in one batch', async (t) => {
  const { spaceId, tmpDir } = await setup(t)
  const landed = path.join(tmpDir('dl'), 'p.txt')
  fs.writeFileSync(landed, 'bytes')
  for (const drivePath of ['/Docs/one.txt', '/Docs/two.txt', '/Docs/three.txt']) {
    await markDownloaded(spaceId, drivePath, landed, { hash: 'h' })
  }

  t.is(await pruneDownloadClaims(spaceId, []), 0, 'an empty batch is a no-op')
  t.is(await pruneDownloadClaims(spaceId, ['/Docs/one.txt', '/Docs/three.txt']), 2)
  t.alike([...(await listDownloadClaimsForShare(spaceId, 'Docs')).keys()], ['/Docs/two.txt'])
})

// FIX-21 again, now through the verdict the batched listing and the point read share: a file whose
// CONTAINING FOLDER also vanished means the volume is detached, not that the user deleted the copy.
// Pruning there would destroy the claim for a file still sitting on that disk.
test('REGRESSION (FIX-21): a detached volume keeps the claim, a deleted file drops it', async (t) => {
  const { spaceId, tmpDir } = await setup(t)
  const volume = path.join(tmpDir('vol'), 'ExternalDisk')
  fs.mkdirSync(volume, { recursive: true })
  const landed = path.join(volume, 'v.txt')
  fs.writeFileSync(landed, 'bytes')
  await markDownloaded(spaceId, '/Docs/v.txt', landed, { hash: 'h1' })

  const rec = (await listDownloadClaimsForShare(spaceId, 'Docs')).get('/Docs/v.txt')
  t.is(verdictForClaim(spaceId, '/Docs/v.txt', rec, 'h1').downloaded, true, 'present on the mounted volume')

  fs.rmSync(volume, { recursive: true, force: true })
  const detached = verdictForClaim(spaceId, '/Docs/v.txt', rec, 'h1')
  t.is(detached.prune, false, 'the volume is gone, so the claim is NOT pruned')
  t.is(detached.downloaded, false, 'but the file is not reported as on this device')
  t.absent(await isDownloadedFile(spaceId, '/Docs/v.txt', 'h1'), 'the point-read path agrees')
  t.is(await getDownloadedPath(spaceId, '/Docs/v.txt'), landed, 'and the record survived the read')

  fs.mkdirSync(volume, { recursive: true })
  t.is(verdictForClaim(spaceId, '/Docs/v.txt', rec, 'h1').prune, true, 'the folder back without the file is a deletion')
})
