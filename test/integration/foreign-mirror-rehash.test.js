import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setupSelfMirror } from '../helpers/owned.js'
import { initialMaterializeScan, materializeCatalogFile } from '../../src/shared/folders/mirror-pass.js'
import { overlayHashFile } from '../../src/shared/transfer/backends/overlay/overlay-hash.js'
import { overlayBackend } from '../../src/shared/transfer/backends/overlay/index.js'
import { getForeignMount } from '../../src/shared/folders/mount-store.js'
import { initDownloads } from '../../src/shared/transfer/files.js'

// A counting hasher proves the on-disk read actually happened (or didn't) — the
// same seam the preview path uses in preview-scan.test.js.
function countingHash(real) {
  let calls = 0
  const fn = async (p) => { calls += 1; return real(p) }
  fn.calls = () => calls
  return fn
}

// REGRESSION (FIX-MIRROR-REHASH): the 30s foreign-mirror poll tick used to
// full-file re-hash EVERY already-mirrored file every cycle — it wrote the
// verified-hash record but never read it back to skip the read. On Windows
// (Defender-scanned reads, slow disk, no page cache) that pinned the Bare worker
// at ~30% CPU for a large mirror. An unchanged, already-verified file must be
// recognized from the verified record without re-hashing, as the preview path does.
test('a poll tick does not re-hash an unchanged, already-verified mirror file', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'aaaa' } })
  await initDownloads()
  await initialMaterializeScan(ctx.mount)
  t.is(fs.readFileSync(path.join(ctx.mirrorPath, 'a.txt'), 'utf8'), 'aaaa', 'file mirrored on the initial scan')

  // Re-drive the same entry through the tick path the poll uses: a fresh mount
  // reload carrying the persisted syncedPaths, so resolveLocalRelPath itself does
  // not hash. The verified record from the initial scan must make this a no-op
  // WITHOUT reading the file.
  const cur = await getForeignMount(ctx.spaceId, ctx.share.id)
  const { entries: [entry] } = await overlayBackend.listPeerWithMeta(ctx.spaceId, ctx.share)
  const spy = countingHash(overlayHashFile)
  await materializeCatalogFile(cur, ctx.share, entry, { hashOf: spy })
  t.is(spy.calls(), 0, 'the unchanged, verified file was not re-hashed on the tick')
})

// The verified-cache short-circuit must not blind the mirror to a genuine local
// edit: a file changed after the record (mtime strictly later than rec.at) still
// gets re-hashed so the tick can detect the drift and re-fetch.
test('a poll tick re-hashes a mirror file edited after it was verified', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'aaaa' } })
  await initDownloads()
  await initialMaterializeScan(ctx.mount)

  const abs = path.join(ctx.mirrorPath, 'a.txt')
  fs.writeFileSync(abs, 'bbbb') // same size, different content — an in-place edit
  const future = new Date(Date.now() + 60000)
  fs.utimesSync(abs, future, future) // mtime strictly after the verified record

  const cur = await getForeignMount(ctx.spaceId, ctx.share.id)
  const { entries: [entry] } = await overlayBackend.listPeerWithMeta(ctx.spaceId, ctx.share)
  const spy = countingHash(overlayHashFile)
  await materializeCatalogFile(cur, ctx.share, entry, { hashOf: spy })
  t.is(spy.calls(), 1, 'the locally-edited file was re-hashed (stale cache did not suppress it)')
})

// The short-circuit must also honor a SIZE mismatch, matching the preview path: a
// mirror file replaced with different-size content whose mtime was NOT advanced
// (a backup restore with cp -p / rsync -t preserves mtime) still gets re-hashed,
// so the divergent local copy is repaired rather than silently trusted.
test('a poll tick re-hashes a mirror file whose size changed even if mtime was preserved', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'aaaa' } })
  await initDownloads()
  await initialMaterializeScan(ctx.mount)

  const abs = path.join(ctx.mirrorPath, 'a.txt')
  fs.writeFileSync(abs, 'bb') // different size (2 vs 4)
  const past = new Date(Date.now() - 60000)
  fs.utimesSync(abs, past, past) // mtime preserved/backdated, i.e. <= the verified record

  const cur = await getForeignMount(ctx.spaceId, ctx.share.id)
  const { entries: [entry] } = await overlayBackend.listPeerWithMeta(ctx.spaceId, ctx.share)
  const spy = countingHash(overlayHashFile)
  await materializeCatalogFile(cur, ctx.share, entry, { hashOf: spy })
  t.is(spy.calls(), 1, 'the size mismatch defeated the verified-cache short-circuit')
})

// REGRESSION (FIX-VERIFY-MTIME-2): the size check above is the only thing that caught an
// mtime-preserving restore, so the SAME-size case walked straight through — every tick, forever.
// Nothing else re-reads a mirrored file: the mirror's watcher asks only whether a file is still
// the one that landed, and the full-walk backstop forces a walk that hits this same short-circuit. A replacement whose mtime
// did not move past the record must still be re-hashed, or the mirror reports a divergent file as
// synced and verified for as long as the mount lives.
test('a poll tick re-hashes a same-size mirror file whose mtime was preserved', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'aaaa' } })
  await initDownloads()
  await initialMaterializeScan(ctx.mount)

  const abs = path.join(ctx.mirrorPath, 'a.txt')
  fs.writeFileSync(abs, 'bbbb') // same size, different content — a restored older revision
  const past = new Date(Date.now() - 60000)
  fs.utimesSync(abs, past, past) // mtime carried over by cp -p / rsync -t, i.e. <= the record

  const cur = await getForeignMount(ctx.spaceId, ctx.share.id)
  const { entries: [entry] } = await overlayBackend.listPeerWithMeta(ctx.spaceId, ctx.share)
  const spy = countingHash(overlayHashFile)
  await materializeCatalogFile(cur, ctx.share, entry, { hashOf: spy })
  t.is(spy.calls(), 1, 'the backdated same-size replacement defeated the verified-cache short-circuit')
  t.is(fs.readFileSync(abs, 'utf8'), 'aaaa', 'and the owner’s bytes were put back')
})
