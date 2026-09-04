import test from 'brittle'
import { createPreviewTally } from '../../src/shared/folders/preview-tally.js'
import { PREVIEW_DETAIL_MAX_FILES } from '../../src/shared/folders/preview-detail.js'

test('an empty tally is a well-formed result for either direction', (t) => {
  const up = createPreviewTally().result('add-owned-folder', 'upload')
  t.alike(
    { ...up, perFile: up.perFile.length },
    { flow: 'add-owned-folder', toUpload: 0, toDownload: 0, conflicts: 0, totalBytes: 0, perFile: 0, perFileOmitted: false },
  )
  const down = createPreviewTally().result('mount-foreign-folder', 'download')
  t.is(down.toDownload, 0)
  t.is(down.toUpload, 0, 'the unused direction is always 0, never undefined')
})

test('direction routes the one count onto the right field', (t) => {
  const a = createPreviewTally()
  a.add({ relPath: 'x', size: 5 })
  t.alike([a.result('f', 'upload').toUpload, a.result('f', 'upload').toDownload], [1, 0])

  const b = createPreviewTally()
  b.add({ relPath: 'x', size: 5 })
  t.alike([b.result('f', 'download').toUpload, b.result('f', 'download').toDownload], [0, 1])
})

test('conflicts and bytes accumulate; a non-conflict adds bytes only', (t) => {
  const tally = createPreviewTally()
  tally.add({ relPath: 'a', size: 10, conflict: true })
  tally.add({ relPath: 'b', size: 5 })
  const r = tally.result('f', 'download')
  t.is(r.conflicts, 1)
  t.is(r.totalBytes, 15)
  t.is(r.toDownload, 2)
})

test('a size-less entry still counts', (t) => {
  const tally = createPreviewTally()
  tally.add({ relPath: 'a' })
  const r = tally.result('f', 'upload')
  t.is(r.toUpload, 1)
  t.is(r.totalBytes, 0, 'and contributes no bytes rather than NaN')
})

// The cap policy is the thing the two dialogs must not fork on.
test('per-file detail is omitted past the cap, and the flag says so', (t) => {
  const tally = createPreviewTally()
  for (let i = 0; i <= PREVIEW_DETAIL_MAX_FILES + 50; i++) tally.add({ relPath: 'f' + i, size: 1 })
  const r = tally.result('f', 'download')
  t.is(r.perFile.length, 0, 'detail is dropped wholesale, not truncated')
  t.is(r.perFileOmitted, true)
  t.ok(r.toDownload > PREVIEW_DETAIL_MAX_FILES, 'while the count stays honest')
})

test('exactly at the cap the detail is still included', (t) => {
  const tally = createPreviewTally()
  for (let i = 0; i < PREVIEW_DETAIL_MAX_FILES; i++) tally.add({ relPath: 'f' + i, size: 1 })
  const r = tally.result('f', 'upload')
  t.is(r.perFileOmitted, false)
  t.is(r.perFile.length, PREVIEW_DETAIL_MAX_FILES)
})

test('extra fields ride through without colliding with the contract', (t) => {
  const r = createPreviewTally().result('add-owned-folder', 'upload', { totalFiles: 7, overFileLimit: true })
  t.is(r.totalFiles, 7)
  t.is(r.overFileLimit, true)
  t.is(r.flow, 'add-owned-folder')
  t.is(r.toUpload, 0)
})

test('two tallies do not share state', (t) => {
  const a = createPreviewTally()
  const b = createPreviewTally()
  a.add({ relPath: 'x', size: 9, conflict: true })
  t.is(b.result('f', 'upload').toUpload, 0)
  t.is(b.result('f', 'upload').conflicts, 0)
  t.is(b.result('f', 'upload').totalBytes, 0)
})
