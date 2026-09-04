import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setupOwnedShare, setupSelfMirror } from '../helpers/owned.js'
import { initialPublishScan } from '../../src/shared/folders/owned-folders.js'
import { previewInitialPublishScan } from '../../src/shared/folders/owned-preview.js'
import { previewMaterializeScan } from '../../src/shared/folders/foreign-preview.js'
import { overlayHashFile } from '../../src/shared/transfer/backends/overlay/overlay-backend.js'

// The scan-preview dialogs are the user's last confirmation before bytes move.
// They must count uploads/downloads and conflicts honestly.

test('owned preview: counts new uploads and flags content conflicts', async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  // Publish one file, then change it on disk and add a new one.
  fs.writeFileSync(path.join(mountPath, 'tracked.txt'), 'v1')
  await initialPublishScan(spaceId, share.id, mountPath, [])

  fs.writeFileSync(path.join(mountPath, 'tracked.txt'), 'v2-changed')  // conflict vs drive
  fs.writeFileSync(path.join(mountPath, 'fresh.txt'), 'brand new')      // pure upload

  const preview = await previewInitialPublishScan(spaceId, share.id, mountPath, [])
  t.is(preview.flow, 'add-owned-folder')
  t.is(preview.toUpload, 2, 'changed file + new file count as uploads')
  t.is(preview.conflicts, 1, 'the changed-but-known file is a conflict')
  t.is(preview.existingAtDestination, 2, 'two files on disk')
  t.ok(preview.perFile.some((f) => f.relPath === 'tracked.txt' && f.conflict), 'conflict flagged per-file')
})

test('owned preview: an unchanged file is neither an upload nor a conflict', async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  fs.writeFileSync(path.join(mountPath, 'same.txt'), 'identical')
  await initialPublishScan(spaceId, share.id, mountPath, [])

  const preview = await previewInitialPublishScan(spaceId, share.id, mountPath, [])
  t.is(preview.toUpload, 0, 'nothing to upload')
  t.is(preview.conflicts, 0, 'no conflicts')
})

test('foreign preview: counts downloads, conflicts, and pre-existing destination files', async (t) => {
  // setupSelfMirror gives us a real readable share (owner = self) we can preview.
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'aaa', 'b.txt': 'bbb' } })
  const mountPath = ctx.mirrorPath

  // Plant a colliding file (different content) + an unrelated file at the dest.
  fs.writeFileSync(path.join(mountPath, 'a.txt'), 'DIFFERENT')
  fs.writeFileSync(path.join(mountPath, 'unrelated.txt'), 'noise')

  const preview = await previewMaterializeScan(ctx.spaceId, ctx.share.owner, ctx.share.id, mountPath)
  t.is(preview.flow, 'mount-foreign-folder')
  t.is(preview.toDownload, 2, 'both share files would download (a.txt differs, b.txt absent)')
  t.is(preview.conflicts, 1, 'a.txt collides with a different on-disk file')
  t.is(preview.existingAtDestination, 2, 'two files already at the destination')
})

// REGRESSION: a folder previously viewed in Finder carries a hidden .DS_Store
// (and may carry *.mirall.part leftovers). Those were counted toward "N files
// already at the destination", so the preview reported one more file than the
// user could see. Ignorable files must not be counted.
test('REGRESSION: foreign preview ignores .DS_Store / temp files in the destination count', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'x.txt': 'data' } })
  const dest = ctx.mirrorPath
  fs.writeFileSync(path.join(dest, 'real.txt'), 'visible')
  fs.writeFileSync(path.join(dest, '.DS_Store'), 'finder junk')
  fs.writeFileSync(path.join(dest, 'half.mirall.part'), 'in-flight')

  const preview = await previewMaterializeScan(ctx.spaceId, ctx.share.owner, ctx.share.id, dest)
  t.is(preview.existingAtDestination, 1, 'only the user-visible file counts (.DS_Store and *.mirall.part excluded)')
})

test('foreign preview: returns an empty summary when the share is not visible', async (t) => {
  const { spaceId, tmpDir } = await setupOwnedShare(t)
  const preview = await previewMaterializeScan(spaceId, 'deadbeef'.repeat(8), 'no-such-share', tmpDir('dst'))
  t.is(preview.toDownload, 0, 'no downloads for an unknown share')
  t.is(preview.flow, 'mount-foreign-folder')
})

test('owned preview: a new share (shareId=null) is stat-only — counts uploads + bytes, no conflicts', async (t) => {
  const { spaceId, mountPath } = await setupOwnedShare(t)
  fs.writeFileSync(path.join(mountPath, 'a.txt'), 'aaaa')
  fs.writeFileSync(path.join(mountPath, 'b.txt'), 'bb')
  const preview = await previewInitialPublishScan(spaceId, null, mountPath, [])
  t.is(preview.toUpload, 2)
  t.is(preview.totalBytes, 6)
  t.is(preview.conflicts, 0)
  t.is(preview.existingAtDestination, 2)
})

test('owned preview: detail list shown at 50 files, omitted above the cap (51)', async (t) => {
  const { spaceId, mountPath } = await setupOwnedShare(t)
  for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(mountPath, `f${i}.txt`), 'x')
  let p = await previewInitialPublishScan(spaceId, null, mountPath, [])
  t.is(p.toUpload, 50)
  t.is(p.perFile.length, 50, 'full list at the cap')
  t.absent(p.perFileOmitted)

  fs.writeFileSync(path.join(mountPath, 'f50.txt'), 'x')
  p = await previewInitialPublishScan(spaceId, null, mountPath, [])
  t.is(p.toUpload, 51)
  t.is(p.perFile.length, 0, 'list omitted above the cap')
  t.ok(p.perFileOmitted)
})

test('owned preview: emits progress; an aborted signal stops with PREVIEW_CANCELLED', async (t) => {
  const { spaceId, mountPath } = await setupOwnedShare(t)
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(mountPath, `g${i}.txt`), 'data')
  const seen = []
  const p = await previewInitialPublishScan(spaceId, null, mountPath, [], { onProgress: (x) => seen.push(x) })
  t.ok(seen.length >= 1, 'progress emitted')
  t.is(seen[seen.length - 1].scanned, p.existingAtDestination)

  try {
    await previewInitialPublishScan(spaceId, null, mountPath, [], { signal: { aborted: true } })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.code, 'PREVIEW_CANCELLED')
  }
})

test('foreign preview: detail list omitted above the cap', async (t) => {
  const files = {}
  for (let i = 0; i < 51; i++) files[`f${i}.txt`] = 'x'
  const ctx = await setupSelfMirror(t, { files })
  const dest = ctx.tmpDir('dst-large')
  const p = await previewMaterializeScan(ctx.spaceId, ctx.share.owner, ctx.share.id, dest)
  t.is(p.toDownload, 51)
  t.is(p.perFile.length, 0)
  t.ok(p.perFileOmitted)
})

// The preview must not read a file it can decide on cheaply: a different SIZE proves a
// conflict, and a verified-cache hit proves identity. Only a same-size, uncached file is
// hashed. A counting hashOf asserts the read actually happened (or didn't).
function countingHash (real) {
  let calls = 0
  const fn = async (p) => { calls += 1; return real(p) }
  fn.calls = () => calls
  return fn
}

test('foreign preview: a different-SIZE file is a conflict WITHOUT hashing', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'aaaa' } })
  const dest = ctx.mirrorPath
  fs.writeFileSync(path.join(dest, 'a.txt'), 'DIFFERENT-LENGTH')
  const spy = countingHash(overlayHashFile)
  const p = await previewMaterializeScan(ctx.spaceId, ctx.share.owner, ctx.share.id, dest, { hashOf: spy })
  t.is(p.toDownload, 1)
  t.is(p.conflicts, 1, 'size mismatch alone flags the conflict')
  t.is(spy.calls(), 0, 'no file was hashed')
})

test('foreign preview: a verified-cache hit is identical WITHOUT hashing', async (t) => {
  const { markVerified, initDownloads } = await import('../../src/shared/transfer/files.js')
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'aaaa' } })
  const dest = ctx.mirrorPath
  fs.writeFileSync(path.join(dest, 'a.txt'), 'aaaa') // identical bytes
  await initDownloads()
  await markVerified(ctx.spaceId, ctx.share.id + '|a.txt', await overlayHashFile(path.join(dest, 'a.txt')))
  const spy = countingHash(overlayHashFile)
  const p = await previewMaterializeScan(ctx.spaceId, ctx.share.owner, ctx.share.id, dest, { hashOf: spy })
  t.is(p.toDownload, 0, 'cached-identical file is not a download')
  t.is(p.conflicts, 0)
  t.is(spy.calls(), 0, 'the cache hit skipped the read')
})

test('foreign preview: a same-size, uncached, different file is hashed once and flagged', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'aaaa' } })
  const dest = ctx.mirrorPath
  fs.writeFileSync(path.join(dest, 'a.txt'), 'bbbb') // same size (4), different content
  const spy = countingHash(overlayHashFile)
  const p = await previewMaterializeScan(ctx.spaceId, ctx.share.owner, ctx.share.id, dest, { hashOf: spy })
  t.is(p.toDownload, 1)
  t.is(p.conflicts, 1)
  t.is(spy.calls(), 1, 'only the ambiguous same-size file required a read')
})

test('REGRESSION: a cached file edited (same size) after materialize is re-hashed and flagged', async (t) => {
  const { markVerified, initDownloads } = await import('../../src/shared/transfer/files.js')
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'aaaa' } })
  const dest = ctx.mirrorPath
  fs.writeFileSync(path.join(dest, 'a.txt'), 'aaaa')
  await initDownloads()
  await markVerified(ctx.spaceId, ctx.share.id + '|a.txt', await overlayHashFile(path.join(dest, 'a.txt')))
  // User edits the mirrored file in place (same size, different content) AFTER the record.
  fs.writeFileSync(path.join(dest, 'a.txt'), 'bbbb')
  const future = new Date(Date.now() + 60000)
  fs.utimesSync(path.join(dest, 'a.txt'), future, future) // mtime strictly after rec.at
  const spy = countingHash(overlayHashFile)
  const p = await previewMaterializeScan(ctx.spaceId, ctx.share.owner, ctx.share.id, dest, { hashOf: spy })
  t.is(p.toDownload, 1)
  t.is(p.conflicts, 1, 'the locally-edited file is still a conflict (stale cache did not suppress it)')
  t.is(spy.calls(), 1, 'the edited file was re-hashed')
})

test('REGRESSION: a directory at a remote file path is flagged as a conflict', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'aaaa' } })
  const dest = ctx.mirrorPath
  fs.mkdirSync(path.join(dest, 'a.txt')) // a directory where a file should land
  const p = await previewMaterializeScan(ctx.spaceId, ctx.share.owner, ctx.share.id, dest)
  t.is(p.toDownload, 1)
  t.is(p.conflicts, 1, 'a pre-existing non-file at the path is a conflict')
})

test('foreign preview: emits scanning progress and an aborted signal throws PREVIEW_CANCELLED', async (t) => {
  const files = {}
  for (let i = 0; i < 8; i++) files[`f${i}.txt`] = 'x'
  const ctx = await setupSelfMirror(t, { files })
  const dest = ctx.mirrorPath
  const seen = []
  await previewMaterializeScan(ctx.spaceId, ctx.share.owner, ctx.share.id, dest, { onProgress: (p) => seen.push(p) })
  t.ok(seen.some((p) => p.phase === 'scanning'), 'progress emitted during the scan')
  await t.exception(
    previewMaterializeScan(ctx.spaceId, ctx.share.owner, ctx.share.id, dest, { signal: { aborted: true } }),
    /cancelled/i,
    'an aborted preview rejects',
  )
})

// The destination count went through a private readdir copy of walkDisk until it was merged away.
// These two pin the behaviour that copy carried and the shared walk must keep.
test('foreign preview: an unreadable destination counts zero rather than failing', async (t) => {
  const ctx = await setupSelfMirror(t)
  const gone = path.join(ctx.mirrorPath, 'does-not-exist')
  const preview = await previewMaterializeScan(ctx.spaceId, ctx.share.owner, ctx.share.id, gone)
  t.is(preview.existingAtDestination, 0, 'a missing destination is 0, not a throw')
  t.is(preview.flow, 'mount-foreign-folder', 'and the dialog still gets a result')
})

test('foreign preview: ignored files do not inflate the destination count', async (t) => {
  const ctx = await setupSelfMirror(t)
  fs.writeFileSync(path.join(ctx.mirrorPath, 'real.txt'), 'x')
  fs.writeFileSync(path.join(ctx.mirrorPath, '.DS_Store'), 'junk')
  fs.writeFileSync(path.join(ctx.mirrorPath, 'half.mirall.part'), 'junk')
  const preview = await previewMaterializeScan(ctx.spaceId, ctx.share.owner, ctx.share.id, ctx.mirrorPath)
  t.is(preview.existingAtDestination, 1, 'DEFAULT_IGNORE still applies through the shared walk')
})
