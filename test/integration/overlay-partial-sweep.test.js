import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { initPendingTransfers, recordPending } from '../../src/shared/transfer/pending-transfers.js'
import { cleanupOrphanedOverlayPartials } from '../../src/shared/transfer/partial-sweep.js'

test('cleanupOrphanedOverlayPartials sweeps an orphan .overlay-partial, keeps one referenced by a pending finalPath', async (t) => {
  const { downloads } = await freshPeer(t)
  await initPendingTransfers()
  const keptFinal = path.join(downloads, 'keep.bin')
  const kept = keptFinal + '.overlay-partial'
  const orphan = path.join(downloads, 'orphan.bin.overlay-partial')
  for (const f of [kept, orphan]) fs.writeFileSync(f, 'half')
  // The overlay/loose engine records finalPath (not localPath) — the partial is
  // <finalPath>.overlay-partial, so the row's finalPath protects it.
  await recordPending('s', '/keep.bin', { finalPath: keptFinal, inPlace: true })

  await cleanupOrphanedOverlayPartials(downloads)

  t.ok(fs.existsSync(kept), 'overlay partial referenced by a pending finalPath survives')
  t.absent(fs.existsSync(orphan), 'orphaned overlay partial swept')
})

test('cleanupOrphanedOverlayPartials ignores eager .partial and real files', async (t) => {
  const { downloads } = await freshPeer(t)
  await initPendingTransfers()
  const eagerPartial = path.join(downloads, 'legacy.txt.partial')
  const real = path.join(downloads, 'done.txt')
  const orphanOverlay = path.join(downloads, 'gone.bin.overlay-partial')
  for (const f of [eagerPartial, real, orphanOverlay]) fs.writeFileSync(f, 'x')

  await cleanupOrphanedOverlayPartials(downloads)

  t.ok(fs.existsSync(eagerPartial), 'a non-overlay partial is left to its own sweep')
  t.ok(fs.existsSync(real), 'non-partial file untouched')
  t.absent(fs.existsSync(orphanOverlay), 'orphaned overlay partial swept')
})

test('cleanupOrphanedOverlayPartials is a no-op on a missing downloads dir', async (t) => {
  await freshPeer(t)
  await initPendingTransfers()
  await cleanupOrphanedOverlayPartials(path.join('/nonexistent', 'dl-' + Date.now()))
  t.pass('returns without throwing when the dir does not exist')
})
