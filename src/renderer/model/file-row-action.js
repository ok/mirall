// Which buttons a file row offers, for a loose file and a folder file alike. Two slots: the primary
// is always shown; the secondary (the destructive half of a pair) shows on hover or focus. A row
// whose manualControls is false (a mirrored folder) syncs itself and only ever offers Reveal or a
// busy indicator. Unshare and cancel-publish withdraw one own file, which only a loose file can do;
// only own files are ever queued or publishing, so cancel-publish needs no ownership check.
import { isOnDeviceStatus } from '../../shared/contract/statuses.js'
/** @import { FileStatus } from '../types/types.js' */
/** @import { IconName } from '../types/ui.js' */

/** @typedef {'reveal' | 'unshare' | 'download' | 'download-unavailable' | 'pause' | 'cancel' | 'cancel-publish' | 'resume' | 'discard' | 'retry' | 'dismiss' | 'busy'} RowActionId */
/** @typedef {'default' | 'danger'} RowActionTone */
/** @typedef {{ id: RowActionId, icon: IconName, labelKey: string, tone: RowActionTone, disabled?: true }} RowAction */
/** @typedef {{ primary: RowAction | null, secondary: RowAction | null }} RowActions */
/** @typedef {{ isOwn: boolean, manualControls: boolean, ownerFileVerbs: boolean }} RowActionContext */

/** @param {RowActionId} id @param {IconName} icon @param {string} labelKey @param {RowActionTone} [tone] @returns {RowAction} */
const act = (id, icon, labelKey, tone = 'default') => Object.freeze({ id, icon, labelKey, tone })

const A = Object.freeze({
  reveal: act('reveal', 'folder_open', 'file.revealInFolder'),
  unshare: act('unshare', 'delete', 'file.unshare', 'danger'),
  download: act('download', 'download', 'file.download'),
  downloadUnavailable: /** @type {RowAction} */ (Object.freeze({ ...act('download-unavailable', 'download', 'file.downloadUnavailable'), disabled: true })),
  pause: act('pause', 'pause', 'file.pause'),
  cancel: act('cancel', 'close', 'file.cancel', 'danger'),
  cancelPublish: act('cancel-publish', 'close', 'file.cancel', 'danger'),
  resume: act('resume', 'play_arrow', 'file.resume'),
  discard: act('discard', 'close', 'file.discardPartial', 'danger'),
  retry: act('retry', 'refresh', 'file.retry'),
  dismiss: act('dismiss', 'close', 'file.dismiss', 'danger'),
})
/** @param {string} labelKey */
const busy = (labelKey) => act('busy', 'update', labelKey)
/** @param {RowAction | null} primary @param {RowAction | null} [secondary] @returns {RowActions} */
const pair = (primary, secondary = null) => ({ primary, secondary })

/** @param {{ status: FileStatus, transferId?: string }} row @param {RowActionContext} ctx @returns {RowActions} */
export function fileRowActions(row, ctx) {
  const { status } = row
  if (isOnDeviceStatus(status)) {
    const withdraw = ctx.isOwn && ctx.ownerFileVerbs && status === 'synced'
    return pair(A.reveal, withdraw ? A.unshare : null)
  }
  if (status === 'publishing' || status === 'queued') {
    if (ctx.ownerFileVerbs) return pair(A.cancelPublish)
    return pair(busy(status === 'queued' ? 'status.queued' : 'status.publishing'))
  }
  return ctx.manualControls ? manualActions(status, !!row.transferId) : syncedActions(status)
}

/** @param {FileStatus} status @param {boolean} hasTransfer @returns {RowActions} */
function manualActions(status, hasTransfer) {
  /** @param {RowAction} a */
  const ifTransfer = (a) => (hasTransfer ? a : null)
  switch (status) {
    case 'remote': return pair(A.download)
    case 'unavailable': return pair(A.downloadUnavailable)
    case 'preparing': return pair(busy('file.preparing'))
    case 'downloading':
    case 'verifying': return hasTransfer ? pair(A.pause, A.cancel) : pair(busy('file.syncing'))
    case 'paused-interrupted': return pair(A.resume, ifTransfer(A.discard))
    case 'paused-offline': return pair(ifTransfer(A.discard))
    case 'error': return pair(A.retry, ifTransfer(A.dismiss))
    default: return pair(null)
  }
}

/** @param {FileStatus} status @returns {RowActions} */
function syncedActions(status) {
  if (status === 'downloading' || status === 'verifying') return pair(busy('file.syncing'))
  if (status === 'preparing') return pair(busy('file.preparing'))
  return pair(null)
}
