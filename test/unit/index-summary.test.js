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

// Pause DROPS the queue (rebuilding it costs one walk, because a published file is never
// re-hashed), so a paused folder reports the same adding: 0 a finished one reports. Only the mount
// tells them apart — which is why `paused` is independent of `active` rather than derived from it.
test('a paused index renders as paused, not as idle', (t) => {
  const s = deriveIndexSummary({ adding: 0, bytesQueued: 0 }, { indexPaused: true })
  t.absent(s.active, 'no work is queued')
  t.ok(s.paused, 'but the folder is paused, and the notice must say so')
})

test('pausing is not the same as finishing', (t) => {
  t.absent(deriveIndexSummary({ adding: 0 }, { indexPaused: false }).paused)
  t.absent(deriveIndexSummary({ adding: 0 }, null).paused, 'no mount yet is not a pause')
  t.absent(deriveIndexSummary({ adding: 0 }, undefined).paused)
  t.ok(deriveIndexSummary({ adding: 12 }, { indexPaused: true }).paused, 'a pause mid-queue still reads paused')
})

test('the summary is unchanged when no mount is passed', (t) => {
  const s = deriveIndexSummary({ adding: 3, bytesQueued: 99 })
  t.ok(s.active)
  t.is(s.files, 3)
  t.is(s.bytesQueued, 99)
  t.absent(s.paused)
})

// The walk fills no queue, so `adding` is 0 for the whole of it. Reporting that as idle left the
// notice — and with it the only Pause/Stop controls — off screen for the entire scan of a large
// folder, which is exactly the case the controls exist for.
test('the walk phase counts as active even with nothing queued', (t) => {
  const s = deriveIndexSummary({ adding: 0 }, { scanning: true })
  t.ok(s.active, 'the notice renders')
  t.ok(s.scanning, 'and says it is still looking, not that it is adding 0 files')
  t.is(s.files, 0)
})

test('a filled queue supersedes the walk phase', (t) => {
  const s = deriveIndexSummary({ adding: 7 }, { scanning: true })
  t.ok(s.active)
  t.absent(s.scanning, 'once there is work to count, the count is the better sentence')
  t.is(s.files, 7)
})

test('a paused index is never reported as scanning', (t) => {
  // Pause cancels the pass, so a stale 'scanning' status must not outrank the durable pause and
  // put the folder back into the busy notice.
  const s = deriveIndexSummary({ adding: 0 }, { indexPaused: true, scanning: true })
  t.ok(s.paused)
  t.absent(s.scanning)
  t.absent(s.active, 'the paused banner renders instead of the busy one')
})

test("a peer's share has no scan phase to report", (t) => {
  // Members learn of a scan only from queue-depth frames; there is no mount to carry a status.
  t.absent(deriveIndexSummary({ adding: 0 }, null).scanning)
  t.absent(deriveIndexSummary({ adding: 0 }, null).active)
})
