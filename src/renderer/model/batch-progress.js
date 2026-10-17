// One line for the downloads under way in a listing: how many files, how many are done, bytes left
// and the overall percentage, plus the transfers Cancel All stops. It reads the rows, not a record of
// what the user clicked, so the strip and its Cancel All last as long as any download does: across
// a restart, an owner who went offline, and files started one click at a time. A batch the user
// started here adds its finished files while it runs. Pure, so test/unit drives it under plain Node.
import { isOnDeviceStatus } from '../../shared/contract/statuses.js'

/** @typedef {{ files: number, done: number, bytesLeft: number, pct: number, moving: boolean, batchLive: boolean, transferIds: string[] }} BatchProgress */
/** @typedef {{ status: string, size: number, transferId?: string }} ProgressRow */

const MOVING = new Set(['downloading', 'verifying', 'waiting'])
const HELD = new Set(['paused-interrupted', 'paused-offline'])

// One file under way already shows its progress on its own row; the strip is for a set.
const MIN_UNBATCHED = 2

/**
 * `recent` is the window right after a batch request returned, before the listing has re-derived
 * the rows the engine started: an available batch row then still counts, so the strip shows at once.
 * @template {ProgressRow} T
 * @param {{ rows: readonly T[], keyOf: (row: T) => string, bytesOf: (row: T) => number, batchKeys?: readonly string[], recent?: boolean }} args
 * @returns {BatchProgress | null}
 */
export function deriveDownloadProgress({ rows, keyOf, bytesOf, batchKeys = [], recent = false }) {
  const batch = new Set(batchKeys)
  let total = 0
  let got = 0
  let done = 0
  let files = 0
  let moving = false
  let batchLive = false
  /** @type {string[]} */
  const transferIds = []
  for (const row of rows) {
    const inBatch = batch.has(keyOf(row))
    const underWay = MOVING.has(row.status) || HELD.has(row.status) || (inBatch && recent && row.status === 'remote')
    if (inBatch && isOnDeviceStatus(row.status)) {
      files += 1
      done += 1
      total += row.size
      got += row.size
      continue
    }
    if (!underWay) continue
    files += 1
    total += row.size
    got += bytesOf(row)
    if (!HELD.has(row.status)) moving = true
    if (inBatch) batchLive = true
    if (row.transferId) transferIds.push(row.transferId)
  }
  const underWay = files - done
  if (underWay === 0 || (underWay < MIN_UNBATCHED && !batchLive)) return null
  return { files, done, bytesLeft: Math.max(0, total - got), pct: total > 0 ? Math.floor((got / total) * 100) : 0, moving, batchLive, transferIds }
}
