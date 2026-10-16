// One line for a batch the user started: how many files, how many are done, bytes left and the
// overall percentage. Null once nothing in it is moving, which is when the strip goes. Pure, so
// test/unit drives it under plain Node.
import { isOnDeviceStatus } from '../../shared/contract/statuses.js'

/** @typedef {{ files: number, done: number, bytesLeft: number, pct: number }} BatchProgress */
/** @typedef {{ status: string, size: number }} ProgressRow */

const LIVE = new Set(['downloading', 'verifying', 'waiting'])

/**
 * `recent` is the window right after the request returned, before the listing has re-derived the
 * rows the engine started: an available row then still counts as live, so the strip shows at once
 * rather than a beat after the click.
 * @template {ProgressRow} T
 * @param {readonly string[]} keys
 * @param {ReadonlyMap<string, T>} rowsByKey
 * @param {(row: T) => number} bytesOf
 * @param {{ recent?: boolean }} [opts]
 * @returns {BatchProgress | null}
 */
export function deriveBatchProgress(keys, rowsByKey, bytesOf, { recent = false } = {}) {
  let total = 0
  let got = 0
  let done = 0
  let live = 0
  let files = 0
  for (const key of keys) {
    const row = rowsByKey.get(key)
    if (!row) continue
    files += 1
    total += row.size
    if (isOnDeviceStatus(row.status)) {
      done += 1
      got += row.size
      continue
    }
    got += bytesOf(row)
    if (LIVE.has(row.status) || (recent && row.status === 'remote')) live += 1
  }
  if (live === 0) return null
  return { files, done, bytesLeft: Math.max(0, total - got), pct: total > 0 ? Math.floor((got / total) * 100) : 0 }
}
