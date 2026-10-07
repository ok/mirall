import test from 'brittle'
import { snapshotLabel } from '../../src/renderer/model/snapshot-label.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 6, 12)
const snap = (ago, over = {}) => ({
  name: 'n', createdAt: new Date(NOW - ago).toISOString(), suspect: null, spaces: 2, appVersion: null,
  beforeLoss: false, beforeLeaving: null, ...over,
})

test('the newest backup is the latest, whatever else it is', (t) => {
  t.alike(snapshotLabel(snap(DAY, { beforeLoss: true }), 0, NOW), { kind: 'latest' })
})

test('a kept reason names the backup before its age does', (t) => {
  t.alike(snapshotLabel(snap(3 * DAY, { beforeLeaving: ['Holiday'] }), 1, NOW), { kind: 'before-leaving', spaces: ['Holiday'] })
  t.alike(snapshotLabel(snap(3 * DAY, { beforeLoss: true }), 1, NOW), { kind: 'before-loss' })
})

test('the age reads in days, then weeks, then months', (t) => {
  t.alike(snapshotLabel(snap(DAY + 1000), 1, NOW), { kind: 'age', value: 1, unit: 'day' })
  t.alike(snapshotLabel(snap(2 * DAY), 1, NOW), { kind: 'age', value: 2, unit: 'day' })
  t.alike(snapshotLabel(snap(8 * DAY), 1, NOW), { kind: 'age', value: 1, unit: 'week' })
  t.alike(snapshotLabel(snap(15 * DAY), 1, NOW), { kind: 'age', value: 2, unit: 'week' })
  t.alike(snapshotLabel(snap(31 * DAY), 1, NOW), { kind: 'age', value: 1, unit: 'month' })
  t.alike(snapshotLabel(snap(61 * DAY), 1, NOW), { kind: 'age', value: 2, unit: 'month' })
})
