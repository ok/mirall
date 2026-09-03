import test from 'brittle'
import { stallVerdict } from '../../src/shared/core/stall-verdict.js'

const W = 1000

test('a unit with no pass in flight is healthy', (t) => {
  t.alike(stallVerdict({ startedAt: 0, progressAt: 0 }, { now: 10_000, windowMs: W }), { ok: true, detail: null })
})

test('null or undefined liveness is healthy, not a throw', (t) => {
  t.is(stallVerdict(null, { now: 1, windowMs: W }).ok, true)
  t.is(stallVerdict(undefined, { now: 1, windowMs: W }).ok, true)
})

test('a pass that is still advancing is healthy however long it has run', (t) => {
  t.is(stallVerdict({ startedAt: 1, progressAt: 900_000 }, { now: 900_500, windowMs: W }).ok, true)
})

test('a pass with no progress past the window is stalled, with the elapsed seconds in detail', (t) => {
  const v = stallVerdict({ startedAt: 1000, progressAt: 1000 }, { now: 6000, windowMs: W })
  t.is(v.ok, false)
  t.is(v.detail, 'no progress for 5s')
})

test('a pass that never reported progress falls back to its start time', (t) => {
  t.is(stallVerdict({ startedAt: 1000, progressAt: 0 }, { now: 1500, windowMs: W }).ok, true, 'not stalled from the epoch')
  t.is(stallVerdict({ startedAt: 1000, progressAt: 0 }, { now: 3000, windowMs: W }).ok, false)
})

test('exactly at the threshold is still healthy', (t) => {
  t.is(stallVerdict({ startedAt: 1000, progressAt: 1000 }, { now: 2000, windowMs: W }).ok, true)
  t.is(stallVerdict({ startedAt: 1000, progressAt: 1000 }, { now: 2001, windowMs: W }).ok, false)
})
