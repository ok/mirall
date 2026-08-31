import test from 'brittle'
import { deriveIndexSummary } from '../../src/renderer/indexSummary.js'

test('no status yet is not an active scan', (t) => {
  t.absent(deriveIndexSummary(null).active, 'null (before the first read) shows nothing')
  t.absent(deriveIndexSummary(undefined).active)
  t.absent(deriveIndexSummary({}).active, 'an empty status shows nothing')
  t.absent(deriveIndexSummary({ adding: 0, bytesQueued: 0 }).active, 'a drained scan shows nothing')
})

test('the file count is the publish work still outstanding', (t) => {
  const s = deriveIndexSummary({ adding: 42, queued: 40, running: 2, done: 8, bytesQueued: 1024 })
  t.ok(s.active)
  t.is(s.files, 42, 'running and queued both count: a queued file is the one with no row to show it')
  t.is(s.bytesQueued, 1024)
})

// REGRESSION (FIX-INDEX-RETIRE): the queue carries retires too, each enqueued with the departing
// file's size. Counting them made deleting a folder read as "Adding 300 files to this folder ·
// 2.0 GB to read" — the same mislabelling as calling indexing a download, in the other direction.
test('REGRESSION (FIX-INDEX-RETIRE): a queue of deletions is not an addition', (t) => {
  // What the worker reports while a bulk delete drains: work is pending, but none of it is a publish.
  const s = deriveIndexSummary({ adding: 0, queued: 300, running: 2, bytesQueued: 0 })
  t.absent(s.active, 'a delete-only pass announces no additions')
  t.is(s.files, 0)
  t.is(s.bytesQueued, 0, 'and nothing to read — a retire reads no bytes')
})

test('bytes are only reported alongside files still to add', (t) => {
  const s = deriveIndexSummary({ adding: 0, bytesQueued: 999 })
  t.absent(s.active)
  t.is(s.bytesQueued, 0, 'a stale byte count cannot outlive the work it described')
})

test('wire numbers are clamped', (t) => {
  // The status crosses IPC; a malformed frame must not reach the view as NaN or a negative count.
  t.is(deriveIndexSummary({ adding: NaN }).files, 0)
  t.is(deriveIndexSummary({ adding: -3 }).files, 0)
  t.is(deriveIndexSummary({ adding: 2, bytesQueued: Infinity }).bytesQueued, 0, 'a non-finite size is dropped')
  t.is(deriveIndexSummary({ adding: 2, bytesQueued: -5 }).bytesQueued, 0, 'a negative size is dropped')
})
