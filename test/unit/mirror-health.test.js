import test from 'brittle'
import { mirrorVerdict, STALL_FACTOR } from '../../src/shared/folders/mirror-health.js'

const POLL = 30_000
const WINDOW = POLL * STALL_FACTOR
const at = (now) => ({ now, pollIntervalMs: POLL })

test('a mount with no pass in flight is healthy', (t) => {
  t.alike(mirrorVerdict({ startedAt: 0, progressAt: 0, completedAt: 1000 }, at(9_000_000)), { ok: true, detail: null })
  t.alike(mirrorVerdict(undefined, at(9_000_000)), { ok: true, detail: null }, 'a mount never probed is not wedged')
})

// The reason the rule reads progress rather than elapsed time: an initial scan over thousands of
// files is legitimately slow, and an elapsed-time rule would restart it mid-scan.
test('a pass that is still advancing is healthy however long it has run', (t) => {
  const startedAt = 1_000_000
  const now = startedAt + WINDOW * 100
  t.alike(mirrorVerdict({ startedAt, progressAt: now - 1000 }, at(now)), { ok: true, detail: null })
})

test('a pass in flight with no progress past the window is wedged', (t) => {
  const startedAt = 1_000_000
  const now = startedAt + WINDOW + 60_000
  const verdict = mirrorVerdict({ startedAt, progressAt: startedAt }, at(now))
  t.is(verdict.ok, false)
  t.is(verdict.detail, 'no progress for 660s', 'the detail carries how long it has been stuck')
})

test('a pass that never reported progress falls back to its start time', (t) => {
  const startedAt = 1_000_000
  t.is(mirrorVerdict({ startedAt, progressAt: 0 }, at(startedAt + 1000)).ok, true, 'just started is not wedged')
  t.is(mirrorVerdict({ startedAt, progressAt: 0 }, at(startedAt + WINDOW + 1)).ok, false, 'and still stalls on its own')
})

// Exclusive on purpose: a false restart costs a re-scan, so the boundary favours leaving it alone.
test('exactly at the threshold is still healthy', (t) => {
  const startedAt = 1_000_000
  t.is(mirrorVerdict({ startedAt, progressAt: startedAt }, at(startedAt + WINDOW)).ok, true)
  t.is(mirrorVerdict({ startedAt, progressAt: startedAt }, at(startedAt + WINDOW + 1)).ok, false)
})

test('the stall factor scales with the configured poll interval', (t) => {
  const startedAt = 1_000_000
  const fast = { now: startedAt + 20_000, pollIntervalMs: 500 }
  t.is(mirrorVerdict({ startedAt, progressAt: startedAt }, fast).ok, false, 'a 500ms poll wedges far sooner')
})
