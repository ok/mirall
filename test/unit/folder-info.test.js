import test from 'brittle'
import { deriveFolderInfo } from '../../src/renderer/folderInfo.js'

const rows = (sizes) => sizes.map((size, i) => ({ relPath: 'f' + i, size }))

// REGRESSION (FIX-142): the folder header derived fileCount/totalBytes from the worker's
// per-read total. On an incomplete read (offline/transient peer) the worker returns 0/partial
// while reconcileFiles keeps the last-good rows on screen, so the header flashed "0 files / 0 B"
// over a populated list (and `res.total ?? rows.length` does NOT catch a valid 0). deriveFolderInfo
// trusts the read's total only when it is COMPLETE.
test('REGRESSION (FIX-142): an incomplete read shows the displayed-row count, not a partial 0', (t) => {
  const kept = rows([10, 20, 30]) // reconciled last-good rows still on screen
  const info = deriveFolderInfo({ complete: false, total: 0, totalBytes: 0 }, kept)
  t.is(info.fileCount, 3, 'incomplete → count from the displayed rows, not the partial 0')
  t.is(info.totalBytes, 60, 'incomplete → bytes from the displayed rows')
})

test('FIX-142: a complete read uses the true total (drives "first N of M")', (t) => {
  const shown = rows([1, 1, 1, 1, 1]) // capped rows
  const info = deriveFolderInfo({ complete: true, total: 150000, totalBytes: 999 }, shown)
  t.is(info.fileCount, 150000, 'true total even though only 5 rows are shown')
  t.is(info.totalBytes, 999, 'true total bytes from the read')
})

test('FIX-142: a complete EMPTY folder reports 0 (0 is valid, not nullish)', (t) => {
  const info = deriveFolderInfo({ complete: true, total: 0, totalBytes: 0 }, [])
  t.is(info.fileCount, 0, 'complete + 0 → 0 files')
  t.is(info.totalBytes, 0, '0 bytes')
})

test('FIX-142: a complete read with no totalBytes falls back to summing the rows', (t) => {
  const info = deriveFolderInfo({ complete: true, total: 2 }, rows([5, 7]))
  t.is(info.fileCount, 2)
  t.is(info.totalBytes, 12, 'sum of rows when res.totalBytes is absent')
})
