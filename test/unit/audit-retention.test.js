import test from 'brittle'
import {
  AGE_HYSTERESIS, DEFAULT_MAX_ENTRIES, DEFAULT_RETENTION_DAYS,
  ageCutoff, ageWatermark, countCutoffSeq, pruneUpTo, normalizeConfig,
} from '../../src/shared/audit/audit-retention.js'

const DAY = 86400000
const NOW = 1754236800000

test('age cutoff is retentionDays back from now', (t) => {
  t.is(ageCutoff(NOW, 90), NOW - 90 * DAY)
})

test('a non-positive or non-finite retention disables the age bound', (t) => {
  t.is(ageCutoff(NOW, 0), null)
  t.is(ageCutoff(NOW, -1), null)
  t.is(ageCutoff(NOW, Infinity), null)
})

test('count cutoff keeps exactly maxEntries rows', (t) => {
  t.is(countCutoffSeq(1000, 200), 800, 'seqs 801..1000 survive')
  t.is(countCutoffSeq(50, 200), -150, 'a short log yields a negative cut, i.e. nothing to prune')
  t.is(countCutoffSeq(1000, 0), null, 'a zero cap disables the count bound')
})

test('whichever bound binds first wins', (t) => {
  t.is(pruneUpTo({ retentionDays: 90, maxEntries: 200, newestSeq: 1000, seqAtOrBelowAge: 500 }), 800,
    'the count bound prunes more than age here')
  t.is(pruneUpTo({ retentionDays: 90, maxEntries: 200, newestSeq: 1000, seqAtOrBelowAge: 900 }), 900,
    'the age bound prunes more than count here')
})

test('nothing to prune yields null rather than 0', (t) => {
  t.is(pruneUpTo({ retentionDays: 90, maxEntries: 0, newestSeq: 10, seqAtOrBelowAge: null }), null,
    'a null result means "delete nothing"; 0 would delete seq 0')
})

test('a negative count cut never becomes a prune instruction', (t) => {
  t.is(pruneUpTo({ retentionDays: 0, maxEntries: 200, newestSeq: 50, seqAtOrBelowAge: null }), null)
})

test('hysteresis is large enough to survive a plausible clock jump', (t) => {
  t.ok(AGE_HYSTERESIS >= 10, 'one row under the cutoff must never end the walk')
})

test('config normalisation rejects nonsense and keeps the rest', (t) => {
  const current = { enabled: true, retentionDays: DEFAULT_RETENTION_DAYS, maxEntries: DEFAULT_MAX_ENTRIES }
  t.alike(normalizeConfig({ retentionDays: 30 }, current), { ...current, retentionDays: 30 })
  t.alike(normalizeConfig({ retentionDays: -5 }, current), current, 'a negative retention is ignored')
  t.alike(normalizeConfig({ retentionDays: 'lots' }, current), current, 'a non-numeric retention is ignored')
  t.alike(normalizeConfig({ enabled: false }, current), { ...current, enabled: false })
  t.alike(normalizeConfig({ enabled: 'yes' }, current), current, 'a non-boolean enabled is ignored')
  t.alike(normalizeConfig({ retentionDays: 30.7 }, current), { ...current, retentionDays: 30 }, 'floored')
})

const rows = (...stamps) => stamps.map((ts, seq) => ({ seq, ts }))

test('the age watermark is the last row older than the cutoff', async (t) => {
  t.is(await ageWatermark(rows(1, 2, 3, 10, 11), 5), 2)
  t.is(await ageWatermark(rows(10, 11), 5), null, 'no old row, nothing to prune')
  t.is(await ageWatermark(rows(), 5), null)
})

test('the walk stops after AGE_HYSTERESIS young rows, not at the first one', async (t) => {
  const seen = []
  async function* records() {
    for (let seq = 0; seq < 100; seq++) { seen.push(seq); yield { seq, ts: seq < 3 ? 1 : 10 } }
  }
  t.is(await ageWatermark(records(), 5), 2)
  t.is(seen.length, 3 + AGE_HYSTERESIS)
})

test('REGRESSION: a stale ts after fresh rows cannot drag the watermark over them', async (t) => {
  t.is(await ageWatermark(rows(1, 2, 10, 11, 3, 12), 5), 1, 'capped below the first young row (seq 2)')
  t.is(await ageWatermark(rows(10, 1), 5), null, 'a cap below seq 0 means nothing')
})
