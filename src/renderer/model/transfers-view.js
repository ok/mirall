// What the transfers page shows of the worker's list: the filter, its counts, the order of the
// space groups, and which of the two bulk verbs applies. Pure, so the screen only renders it.
import { FILE_STATUS } from '../../shared/contract/statuses.js'
/** @import { FileStatus } from '../types/types.js' */
/** @import { TransferSpace } from '../../shared/contract/responses.js' */

export const TRANSFER_FILTER = Object.freeze({ ALL: 'all', DOWNLOADING: 'downloading', SENDING: 'sending', ATTENTION: 'attention' })
export const TRANSFER_FILTERS = Object.freeze(Object.values(TRANSFER_FILTER))
/** @typedef {(typeof TRANSFER_FILTERS)[number]} TransferFilter */
/** @typedef {Record<TransferFilter, number>} TransferCounts */

/** @type {ReadonlySet<FileStatus>} */
const MOVING = new Set([FILE_STATUS.DOWNLOADING, FILE_STATUS.WAITING, FILE_STATUS.VERIFYING])
// A download that will not finish without the user, or without its owner coming back.
/** @type {ReadonlySet<FileStatus>} */
const ATTENTION = new Set([FILE_STATUS.PAUSED_INTERRUPTED, FILE_STATUS.PAUSED_OFFLINE, FILE_STATUS.ERROR])

/** @param {FileStatus} status */
export const needsAttention = (status) => ATTENTION.has(status)

/** @param {readonly TransferSpace[]} spaces @returns {TransferCounts} */
export function transferCounts(spaces) {
  const counts = { all: 0, downloading: 0, sending: 0, attention: 0 }
  for (const space of spaces) {
    counts.sending += space.serving.length
    for (const { file } of space.downloads) {
      if (MOVING.has(file.status)) counts.downloading++
      else if (ATTENTION.has(file.status)) counts.attention++
    }
  }
  counts.all = counts.downloading + counts.sending + counts.attention
  return counts
}

// The groups a filter leaves, without the spaces it empties.
/** @param {readonly TransferSpace[]} spaces @param {TransferFilter} filter @returns {TransferSpace[]} */
export function filterTransfers(spaces, filter) {
  if (filter === TRANSFER_FILTER.ALL) return spaces.filter((s) => s.downloads.length + s.serving.length > 0)
  const keep = filter === TRANSFER_FILTER.DOWNLOADING ? MOVING : filter === TRANSFER_FILTER.ATTENTION ? ATTENTION : null
  return spaces
    .map((s) => ({
      spaceId: s.spaceId,
      downloads: keep ? s.downloads.filter((d) => keep.has(d.file.status)) : [],
      serving: filter === TRANSFER_FILTER.SENDING ? s.serving : [],
    }))
    .filter((s) => s.downloads.length + s.serving.length > 0)
}

// Spaces with something that needs the user come first, then the rest, each by name.
/** @param {readonly TransferSpace[]} spaces @param {(spaceId: string) => string} nameOf @returns {TransferSpace[]} */
export function orderTransferSpaces(spaces, nameOf) {
  const rank = (/** @type {TransferSpace} */ s) => (s.downloads.some((d) => ATTENTION.has(d.file.status)) ? 0 : 1)
  return [...spaces].sort((a, b) => rank(a) - rank(b) || nameOf(a.spaceId).localeCompare(nameOf(b.spaceId)))
}

/** @param {TransferSpace} space @returns {{ transfers: number, paused: number, failed: number }} */
export function spaceTransferSummary(space) {
  let paused = 0
  let failed = 0
  for (const { file } of space.downloads) {
    if (file.status === FILE_STATUS.ERROR) failed++
    else if (ATTENTION.has(file.status)) paused++
  }
  return { transfers: space.downloads.length + space.serving.length, paused, failed }
}

// Pause Downloads while a download is moving; Resume Downloads once none is and one was paused by the user or
// an interruption. A download waiting for its owner resumes by itself and offers neither.
/** @param {readonly TransferSpace[]} spaces @returns {'pause' | 'resume' | null} */
export function transferBulkVerb(spaces) {
  let resumable = false
  for (const space of spaces) {
    for (const { file } of space.downloads) {
      if (MOVING.has(file.status)) return 'pause'
      if (file.status === FILE_STATUS.PAUSED_INTERRUPTED) resumable = true
    }
  }
  return resumable ? 'resume' : null
}
