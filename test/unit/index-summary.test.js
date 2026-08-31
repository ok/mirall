import test from 'brittle'
import { deriveIndexSummary } from '../../src/renderer/indexSummary.js'

test('no status yet is not an active scan', (t) => {
  t.absent(deriveIndexSummary(null).active, 'null (before the first read) shows nothing')
  t.absent(deriveIndexSummary(undefined).active)
  t.absent(deriveIndexSummary({}).active, 'an empty status shows nothing')
  t.absent(deriveIndexSummary({ queued: 0, running: 0, bytesQueued: 0 }).active, 'a drained scan shows nothing')
})

test('the file count is the work still outstanding — running plus queued', (t) => {
  const s = deriveIndexSummary({ running: 2, queued: 40, done: 8, bytesQueued: 1024 })
  t.ok(s.active)
  t.is(s.files, 42, 'both lanes count: a queued file is exactly the one with no row to show it')
  t.is(s.running, 2)
  t.is(s.queued, 40)
  t.is(s.bytesQueued, 1024)
})

test('a running-only scan reports no queued bytes', (t) => {
  // bytesForShare drops an item when it starts, so with nothing queued the number is 0 anyway —
  // but it must not be shown even if the worker sent a stale one: the running file's bytes are
  // already on its own row's bar, and repeating them here would double-count.
  const s = deriveIndexSummary({ running: 1, queued: 0, bytesQueued: 999 })
  t.ok(s.active, 'still an active scan')
  t.is(s.files, 1)
  t.is(s.bytesQueued, 0, 'nothing waiting, so nothing is reported as left to read')
})

test('wire numbers are clamped', (t) => {
  // The status crosses IPC; a malformed frame must not reach the view as NaN or a negative count.
  const s = deriveIndexSummary({ running: NaN, queued: -3, bytesQueued: Infinity })
  t.absent(s.active)
  t.is(s.files, 0)
  t.is(s.bytesQueued, 0)
  t.is(deriveIndexSummary({ running: 1, queued: 2, bytesQueued: -5 }).bytesQueued, 0, 'a negative size is dropped')
})
