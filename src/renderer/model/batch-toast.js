// What a batch download says when its requests return, in one toast under the space's Download-to id.
/** @import { TFunction } from 'i18next' */
/** @import { BatchDownloadResult } from '../../shared/contract/responses.js' */

/**
 * What a batch says about the files it did not start: already here, waiting, removed, failed.
 * @param {BatchDownloadResult} res @param {TFunction} t @returns {string[]}
 */
export function batchNotes(res, t) {
  if ('mirrored' in res) return []
  const parts = []
  if (res.alreadyHere > 0) parts.push(t('batch.onDevice', { count: res.alreadyHere }))
  if (res.waitingOnOwner > 0) parts.push(t('batch.waitingOnOwner', { count: res.waitingOnOwner }))
  if (res.removed > 0) parts.push(t('batch.removedUpstream', { count: res.removed }))
  if (res.failed > 0) parts.push(t('batch.failed', { count: res.failed }))
  return parts
}

/**
 * A batch's one toast, from the responses of the requests that were answered. Whether the batch
 * made its folder the space's is the worker's to say (`folderChanged`), and DownloadToToastBridge
 * names a new folder on its own: the batch speaks only when it has notes, led by `moved` — the
 * sentence naming the new folder — when it moved. Null when there is nothing to say, as when every
 * request was refused: nothing moved, and the error says why.
 * @param {{ results: readonly BatchDownloadResult[], moved: string | null, t: TFunction }} args
 * @returns {string | null}
 */
export function batchToastText({ results, moved, t }) {
  const notes = results.flatMap((res) => batchNotes(res, t))
  if (notes.length === 0) return null
  const changed = results.some((res) => res.folderChanged === true)
  return (changed && moved ? [moved, ...notes] : notes).join(' · ')
}
