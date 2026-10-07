// What the restore list calls a backup: why it is kept, or else how old it is. Retention keeps one per
// age step, so the age reads as the step: yesterday, two days ago, last week, last month.
/** @import { RestorableSnapshot } from '../../shared/contract/responses.js' */

const DAY = 24 * 60 * 60 * 1000

/**
 * @typedef {{ kind: 'latest' } | { kind: 'before-leaving', spaces: string[] } | { kind: 'before-loss' }
 *   | { kind: 'age', value: number, unit: 'day' | 'week' | 'month' }} SnapshotLabel
 */

/**
 * @param {RestorableSnapshot} snapshot
 * @param {number} index its place in the list, newest first
 * @param {number} now
 * @returns {SnapshotLabel}
 */
export function snapshotLabel(snapshot, index, now) {
  if (index === 0) return { kind: 'latest' }
  if (snapshot.beforeLeaving) return { kind: 'before-leaving', spaces: snapshot.beforeLeaving }
  if (snapshot.beforeLoss) return { kind: 'before-loss' }
  const days = Math.max(0, Math.floor((now - Date.parse(snapshot.createdAt)) / DAY))
  if (days < 7) return { kind: 'age', value: days, unit: 'day' }
  if (days < 30) return { kind: 'age', value: Math.floor(days / 7), unit: 'week' }
  return { kind: 'age', value: Math.floor(days / 30), unit: 'month' }
}
