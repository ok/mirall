import test from 'brittle'
import {
  rewriteDue, needsMeasure, rewriteSaves, liveScanLimit, normalizeRewriteState, copyOverhead,
  REWRITE_MIN_HISTORY_BYTES as FLOOR, REWRITE_MAX_LIVE_BYTES as MAX_LIVE,
} from '../../src/shared/storage/local-bee-rules.js'

test('the measured install is due; ordinary bees are not', (t) => {
  t.ok(rewriteDue({ coreBytes: 625e6, liveBytes: 0.23e6 }), 'mounts-meta on the reporting install')
  t.absent(rewriteDue({ coreBytes: 19e6, liveBytes: 0 }), 'below the byte floor')
  t.absent(rewriteDue({ coreBytes: 53.8e6, liveBytes: 21.9e6 }), 'an audit log written row by row')
  t.absent(rewriteDue({ coreBytes: 1.2e6, liveBytes: 0.4e6 }), 'a small bee')
})

test('a fresh copy never qualifies again', (t) => {
  for (const live of [0.05e6, 7.3e6, 21.9e6, 200e6]) {
    t.absent(rewriteDue({ coreBytes: Math.ceil(live * 1.12), liveBytes: live }), 'a fresh copy of ' + live + ' bytes')
  }
})

test('the thresholds are inclusive', (t) => {
  t.ok(rewriteDue({ coreBytes: FLOOR, liveBytes: 0 }), 'exactly the floor')
  t.ok(rewriteDue({ coreBytes: 40e6, liveBytes: 10e6 }), 'exactly four times live data')
  t.absent(rewriteDue({ coreBytes: 40e6 - 1, liveBytes: 10e6 }), 'just under four times')
})

test('a bee is scanned only when it is big and moved by the floor since its verdict', (t) => {
  t.absent(needsMeasure({ coreBytes: FLOOR - 1, prior: null }), 'small: never scanned')
  t.ok(needsMeasure({ coreBytes: FLOOR, prior: null }), 'big and never measured')
  t.absent(needsMeasure({ coreBytes: 60e6, prior: { coreBytes: 45e6 } }), 'grew by less than the floor')
  t.ok(needsMeasure({ coreBytes: 65e6, prior: { coreBytes: 45e6 } }), 'grew by the floor')
  t.ok(needsMeasure({ coreBytes: 30e6, prior: { coreBytes: 90e6 } }), 'shrank')
})

test('the overhead a copy measured is what the rule compares against', (t) => {
  t.ok(rewriteDue({ coreBytes: 60e6, liveBytes: 12e6 }), 'counted as JSON bytes alone, 5x looks due')
  t.absent(rewriteDue({ coreBytes: 60e6, liveBytes: 12e6, overhead: 2.8 }), 'at the measured 2.8x it is not')
  t.is(copyOverhead({ copyBytes: 28e6, liveBytes: 10e6 }), 2.8)
  t.is(copyOverhead({ copyBytes: 5, liveBytes: 10 }), 1, 'never below one')
  t.is(copyOverhead({ copyBytes: 5, liveBytes: 0 }), 5, 'an empty bee does not divide by zero')
})

test('a bee with more live data than a boot should copy is never due', (t) => {
  t.ok(rewriteDue({ coreBytes: 1e9, liveBytes: MAX_LIVE }))
  t.absent(rewriteDue({ coreBytes: 1e9, liveBytes: MAX_LIVE + 1 }))
})

test('the live scan stops where no verdict can be due', (t) => {
  t.is(liveScanLimit(100e6), 25e6)
  t.is(liveScanLimit(1e9), MAX_LIVE, 'capped by the live limit')
  t.absent(rewriteDue({ coreBytes: 100e6, liveBytes: liveScanLimit(100e6) + 1 }), 'one byte past the limit is never due')
})

test('a copy that frees less than half the floor is abandoned', (t) => {
  t.ok(rewriteSaves({ fromBytes: 625e6, toBytes: 0.23e6 }))
  t.ok(rewriteSaves({ fromBytes: FLOOR / 2, toBytes: 0 }), 'exactly half the floor')
  t.absent(rewriteSaves({ fromBytes: 25e6, toBytes: 16e6 }))
})

test('the state file shape guard', (t) => {
  const empty = { v: 1, restoring: null, measured: {} }
  for (const raw of [null, undefined, 42, 'x', [], { measured: [] }, { restoring: 'mounts-meta' }, { restoring: { name: 'x', fork: -1, scratchLength: 1 } }]) {
    t.alike(normalizeRewriteState(raw), empty, JSON.stringify(raw) + ' reads as empty')
  }
  const raw = {
    restoring: { name: 'mounts-meta', fork: 1, scratchLength: 3, extra: true },
    measured: {
      a: { coreBytes: 1, liveBytes: 2, overhead: 1.4, at: 3 },
      f: { coreBytes: 1, liveBytes: 2, overhead: 0.5 },
      b: { coreBytes: -1, liveBytes: 0 },
      c: { coreBytes: 1, liveBytes: 1.5 },
      d: { coreBytes: 5, liveBytes: 4 },
      e: null,
    },
    extra: 1,
  }
  t.alike(normalizeRewriteState(raw), {
    v: 1,
    restoring: { name: 'mounts-meta', fork: 1, scratchLength: 3 },
    measured: {
      a: { coreBytes: 1, liveBytes: 2, overhead: 1.4, at: 3 },
      f: { coreBytes: 1, liveBytes: 2, overhead: 1, at: 0 },
      d: { coreBytes: 5, liveBytes: 4, overhead: 1, at: 0 },
    },
  })
})
