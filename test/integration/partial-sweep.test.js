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
