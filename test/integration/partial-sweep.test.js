import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { initPendingTransfers, recordPending } from '../../src/shared/transfer/pending-transfers.js'
import { cleanupOrphanedPartials } from '../../src/shared/transfer/partial-sweep.js'

test('cleanupOrphanedPartials sweeps an orphan, keeps one referenced by a pending finalPath', async (t) => {
  const { downloads } = await freshPeer(t)
  await initPendingTransfers()
  const keptFinal = path.join(downloads, 'keep.bin')
  const kept = keptFinal + '.mirall.part'
  const orphan = path.join(downloads, 'orphan.bin.mirall.part')
  for (const f of [kept, orphan]) fs.writeFileSync(f, 'half')
  // The overlay/loose engine records finalPath (not localPath) — the partial is
  // <finalPath>.mirall.part, so the row's finalPath protects it.
  await recordPending('s', '/keep.bin', { finalPath: keptFinal, inPlace: true })

  await cleanupOrphanedPartials(downloads)

  t.ok(fs.existsSync(kept), 'partial referenced by a pending finalPath survives')
  t.absent(fs.existsSync(orphan), 'orphaned partial swept')
})

// REGRESSION (PART-1): the sweep unlinks every match it cannot attribute to a pending row
// or a journal, and it scans the user's real Downloads folder. Firefox and KDE name their
// in-progress downloads `<name>.part` there, IE/Edge use `<name>.partial`. Our suffix must
// carry an ownership token or a boot would destroy a stranger's download. This test fails
// if PARTIAL_SUFFIX is ever loosened to a bare '.part'.
test("cleanupOrphanedPartials leaves other apps' in-progress downloads alone", async (t) => {
  const { downloads } = await freshPeer(t)
  await initPendingTransfers()
  const firefox = path.join(downloads, 'bigvideo.mp4.part')
  const edge = path.join(downloads, 'legacy.txt.partial')
  const real = path.join(downloads, 'done.txt')
  const ours = path.join(downloads, 'gone.bin.mirall.part')
  for (const f of [firefox, edge, real, ours]) fs.writeFileSync(f, 'x')

  await cleanupOrphanedPartials(downloads)

  t.ok(fs.existsSync(firefox), "another app's in-progress .part download survives")
  t.ok(fs.existsSync(edge), "another app's in-progress .partial download survives")
  t.ok(fs.existsSync(real), 'non-partial file untouched')
  t.absent(fs.existsSync(ours), 'our own orphaned partial swept')
})

test('cleanupOrphanedPartials is a no-op on a missing downloads dir', async (t) => {
  await freshPeer(t)
  await initPendingTransfers()
  await cleanupOrphanedPartials(path.join('/nonexistent', 'dl-' + Date.now()))
  t.pass('returns without throwing when the dir does not exist')
})

// Per-space download folders mean there is no longer a single downloads dir. A root
// the sweep skips leaks crash-orphaned partials forever, so every root must be walked
// and one missing root must not abort the rest.
test('cleanupOrphanedPartials walks every download root and skips missing ones', async (t) => {
  const { downloads, tmpDir } = await freshPeer(t)
  await initPendingTransfers()
  const second = tmpDir('dl-space')
  const inGlobal = path.join(downloads, 'a.bin.mirall.part')
  const inSecond = path.join(second, 'b.bin.mirall.part')
  for (const f of [inGlobal, inSecond]) fs.writeFileSync(f, 'half')

  const missing = path.join('/nonexistent', 'dl-' + Date.now())
  await cleanupOrphanedPartials([downloads, missing, second])

  t.absent(fs.existsSync(inGlobal), 'orphan in the global root swept')
  t.absent(fs.existsSync(inSecond), 'orphan in a per-space root swept')
})

test('cleanupOrphanedPartials deduplicates repeated roots', async (t) => {
  const { downloads } = await freshPeer(t)
  await initPendingTransfers()
  const orphan = path.join(downloads, 'dup.bin.mirall.part')
  fs.writeFileSync(orphan, 'half')

  const res = await cleanupOrphanedPartials([downloads, downloads, downloads])

  // Asserting only that the orphan is gone passes with or without the dedup — the repeat
  // passes would simply find nothing left. The scan count is what actually proves it.
  t.is(res.rootsScanned, 1, 'three copies of one root are walked once')
  t.absent(fs.existsSync(orphan), 'and the orphan is swept')
})

// REGRESSION (PART-2): only ENOENT was tolerated, so any other readdir failure was rethrown —
// abandoning every remaining root AND the foreign-mount sweep in the same call, with the sole
// caller swallowing it as one log line. Per-space roots multiply the exposure to N user-chosen
// folders that are validated when they are set and never again.
test('cleanupOrphanedPartials skips an unreadable root and still sweeps the rest', async (t) => {
  const { downloads, tmpDir } = await freshPeer(t)
  await initPendingTransfers()
  const second = tmpDir('dl-space')
  const orphan = path.join(second, 'late.bin.mirall.part')
  fs.writeFileSync(orphan, 'half')
  // A root that is a FILE, not a directory: readdir fails with ENOTDIR, standing in for the
  // EACCES / EIO / ENOTCONN an ejected volume or a stale network mount produces.
  const notADir = path.join(downloads, 'not-a-folder')
  fs.writeFileSync(notADir, 'x')

  const res = await cleanupOrphanedPartials([notADir, second])

  t.is(res.failed, 1, 'the bad root is counted, not thrown')
  t.absent(fs.existsSync(orphan), 'a root listed after it is still swept')
})
