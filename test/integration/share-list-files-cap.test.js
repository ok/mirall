import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space.js'
import { advertise, collectOwnShare } from '../../src/shared/shares/share-catalog.js'
import { overlayListOwn } from '../../src/shared/transfer/backends/overlay/overlay-backend.js'

// REGRESSION (FIX-141): a very large folder (the field repro was 150k files) made
// share:list-files / share:folder-info materialise the ENTIRE catalog as a row array
// (then JSON.stringify it into one IPC frame) on every refresh → "Fatal JavaScript out of
// memory" and a dead worker. The listing now folds in ONE pass: it retains only the first
// `limit` rows while counting + summing ALL of them, so the heap is bounded by the cap yet
// the true total is still known — and because rows and total come from the same traversal,
// total can never be below the rows shown (no "first 5000 of 3200" banner).
async function seed (spaceId, shareId, n) {
  let totalBytes = 0
  for (let i = 0; i < n; i++) {
    const size = i + 1
    totalBytes += size
    await advertise(spaceId, shareId, 'f' + String(i).padStart(4, '0') + '.bin', { size, mtime: i })
  }
  return totalBytes
}

test('REGRESSION (FIX-141): one bounded pass yields capped rows AND the true total', async (t) => {
  await freshPeer(t)
  const { spaceId } = await createSpace('Aurora')
  const shareId = 'big'
  const N = 25
  const totalBytes = await seed(spaceId, shareId, N)

  // Uncapped: every row, plus the true totals.
  const full = await collectOwnShare(spaceId, shareId)
  t.is(full.entries.length, N, 'uncapped returns every row')
  t.is(full.total, N, 'true count')
  t.is(full.totalBytes, totalBytes, 'true total bytes')

  // Capped at 10: the materialised array is bounded (no heap blow-up), but the count/bytes
  // are the TRUE totals from the same pass. Before the fix the row array was the full N.
  const capped = await collectOwnShare(spaceId, shareId, 10)
  t.is(capped.entries.length, 10, 'rows bounded by the cap')
  t.is(capped.total, N, 'true count survives the cap')
  t.is(capped.totalBytes, totalBytes, 'true total bytes survive the cap')
  t.ok(capped.total >= capped.entries.length, 'total is never below the rows shown')

  // limit=0 → count-only (what folder-info uses): no rows retained, totals intact. This is
  // the path that used to materialise the whole catalog and OOM in MirrorFolderModal.
  const countOnly = await collectOwnShare(spaceId, shareId, 0)
  t.is(countOnly.entries.length, 0, 'limit=0 retains no rows')
  t.is(countOnly.total, N, 'limit=0 still counts everything')
  t.is(countOnly.totalBytes, totalBytes, 'limit=0 still sums everything')

  // The overlay backend threads the cap through to the same fold.
  const viaBackend = await overlayListOwn(spaceId, shareId, 10)
  t.is(viaBackend.entries.length, 10, 'overlayListOwn caps rows')
  t.is(viaBackend.total, N, 'overlayListOwn carries the true total')
})
