import test from 'brittle'
import { decideSweep, SWEEP_REFUSAL } from '../../src/shared/storage/sweep-decision.js'

const caps = { minSweepPurgeCores: 8, maxSweepPurgeCores: 64, maxSweepPurgeRatio: 0.5 }
const gap = [{ stage: 'own-catalog:s1', detail: 'no sck' }]

test('a complete scan with a plausible target set is allowed', (t) => {
  t.ok(decideSweep({ gaps: [], targetCount: 3, totalCores: 20, caps }).allow)
})

test('REGRESSION (FIX-D1): any gap refuses the sweep, however small the target set', (t) => {
  const d = decideSweep({ gaps: gap, targetCount: 1, totalCores: 100, caps })
  t.absent(d.allow, 'one unreadable core is enough to withhold every deletion')
  t.is(d.reason, SWEEP_REFUSAL.SCAN_INCOMPLETE)
  t.is(d.gaps.length, 1, 'the reason travels with the decision so the journal can record it')
})

test('an empty target set is allowed even with gaps — there is nothing to risk', (t) => {
  t.ok(decideSweep({ gaps: gap, targetCount: 0, totalCores: 10, caps }).allow)
})

test('an implausibly large target set is refused outright, not trimmed', (t) => {
  const d = decideSweep({ gaps: [], targetCount: 65, totalCores: 1000, caps })
  t.absent(d.allow)
  t.is(d.reason, SWEEP_REFUSAL.OVER_ABSOLUTE_CAP)
})

test('more than half the store is refused', (t) => {
  const d = decideSweep({ gaps: [], targetCount: 12, totalCores: 20, caps })
  t.absent(d.allow)
  t.is(d.reason, SWEEP_REFUSAL.OVER_RATIO_CAP)
  t.is(d.limit, 10, 'the limit it would have allowed is reported')
})

test('the floor beats the ratio on a small store', (t) => {
  t.ok(decideSweep({ gaps: [], targetCount: 6, totalCores: 6, caps }).allow,
    'a fresh install must still be able to reclaim a handful of strays')
})

test('the absolute cap is checked before the ratio', (t) => {
  t.is(decideSweep({ gaps: [], targetCount: 100, totalCores: 1000, caps }).reason,
    SWEEP_REFUSAL.OVER_ABSOLUTE_CAP, '100 is under half of 1000 but over the absolute ceiling')
})

test('defaults apply when no caps are supplied', (t) => {
  t.absent(decideSweep({ gaps: [], targetCount: 65, totalCores: 1000 }).allow)
  t.ok(decideSweep({ gaps: [], targetCount: 8, totalCores: 8 }).allow)
})
