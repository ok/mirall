import test from 'brittle'
import { SETTLE, ABANDON, settleVerdict, abandonReason } from '../../src/shared/transfer/backends/overlay/settle-verdict.js'

const slot = (over = {}) => ({ paused: false, cancelled: false, restartJob: null, republishing: false, ownerKey: 'o', ...over })
const OK = { ok: true }
const STALL = { ok: false }
const FAIL = { ok: false, code: 'ENOSPC' }
const ABORT = { ok: false, code: 'ECANCELLED' }
const RESTART = { restartJob: { contentHash: 'new' } }

test('the result speaks only when no intent landed on the slot', (t) => {
  t.is(settleVerdict(slot(), OK), SETTLE.DONE)
  t.is(settleVerdict(slot(), STALL), SETTLE.STALLED, 'a code-less miss is a stall, not a failure')
  t.is(settleVerdict(slot(), FAIL), SETTLE.FAILED)
  t.is(settleVerdict(slot(), ABORT), SETTLE.DISCARDED, 'an abort nobody on the slot asked for was already handled')
  t.is(settleVerdict(undefined, OK), SETTLE.DONE, 'a slot that vanished reads as no intent')
})

test('a pause turns the abort into a pause and nothing else', (t) => {
  t.is(settleVerdict(slot({ paused: true }), ABORT), SETTLE.PAUSED)
  t.is(settleVerdict(slot({ paused: true }), OK), SETTLE.DONE, 'bytes that beat the abort still complete')
  t.is(settleVerdict(slot({ paused: true }), STALL), SETTLE.STALLED)
})

test('a cancel outranks the result however the fetch ended', (t) => {
  for (const r of [OK, STALL, FAIL, ABORT]) t.is(settleVerdict(slot({ cancelled: true }), r), SETTLE.CANCELLED)
})

test('a supersede outranks a cancel — the cancel flag is how it aborts the old fetch', (t) => {
  for (const r of [OK, STALL, FAIL, ABORT]) t.is(settleVerdict(slot({ cancelled: true, ...RESTART }), r), SETTLE.RESTART)
})

test('the republish park ranks above the result and below every user intent', (t) => {
  const parked = { republishing: true }
  for (const r of [OK, STALL, FAIL, ABORT]) t.is(settleVerdict(slot(parked), r), SETTLE.PARK, 'even a lucky completion of the OLD bytes parks')
  t.is(settleVerdict(slot({ ...parked, paused: true }), ABORT), SETTLE.PAUSED)
  t.is(settleVerdict(slot({ ...parked, cancelled: true }), ABORT), SETTLE.CANCELLED)
  t.is(settleVerdict(slot({ ...parked, cancelled: true, ...RESTART }), ABORT), SETTLE.RESTART)
})

test('abandonReason ranks a landed intent above reachability', (t) => {
  const online = { ownerOnline: () => true }
  const offline = { ownerOnline: () => false }
  t.is(abandonReason(slot(), online), null)
  t.is(abandonReason(slot({ cancelled: true }), online), ABANDON.CANCELLED)
  t.is(abandonReason(slot({ cancelled: true, ...RESTART }), online), ABANDON.RESTART)
  t.is(abandonReason(slot({ paused: true }), offline), ABANDON.PAUSED, 'a pause is reported before the owner is even asked')
  t.is(abandonReason(slot(), offline), ABANDON.OFFLINE)
})

test('abandonReason asks the overlay only when given a probe for it', (t) => {
  const torn = { ownerOnline: () => true, hasOverlay: () => false }
  t.is(abandonReason(slot(), torn), ABANDON.NO_OVERLAY)
  t.is(abandonReason(slot(), { ownerOnline: () => true }), null, 'the pre-fetch guard never asked')
  t.is(abandonReason(slot({ paused: true }), torn), ABANDON.PAUSED, 'and a pause still ranks above it')
})
