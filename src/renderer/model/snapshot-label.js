// What the restore list calls a backup: why it is kept, or else how old it is. Retention keeps one per
// age step, so the age reads as the step: yesterday, two days ago, last week, last month.
/** @import { RestorableSnapshot } from '../../shared/contract/responses.js' */
/** @import { RelativeAge } from './relative-age.js' */
import { relativeAge } from './relative-age.js'

/**
 * @typedef {{ kind: 'latest' } | { kind: 'before-leaving', spaces: string[] } | { kind: 'before-loss' }
 *   | ({ kind: 'age' } & RelativeAge)} SnapshotLabel
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
  return { kind: 'age', ...relativeAge(now - Date.parse(snapshot.createdAt), { smallest: 'day' }) }
}
