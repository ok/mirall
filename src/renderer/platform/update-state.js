// The renderer's view of main's update status, plus the banner's dismissal. The banner shows while
// an update is staged and not dismissed; About ignores the dismissal. A different staged version
// clears it, so a newer update is announced again.
import { UPDATE_STATE } from '../../shared/contract/update-status.js'

/**
 * @import { UpdateStatus } from '../../shared/contract/update-status.js'
 * @typedef {{ status: UpdateStatus, dismissed: boolean }} UpdateViewState
 */

/** @type {UpdateViewState} */
export const initialUpdateState = {
  status: { state: UPDATE_STATE.IDLE, nextVersion: null, lastCheckedAt: null, offReason: null, canRestart: false },
  dismissed: false,
}

/**
 * @param {UpdateViewState} prev
 * @param {UpdateStatus} status
 * @returns {UpdateViewState}
 */
export function reduceStatus(prev, status) {
  return { status, dismissed: status.nextVersion === prev.status.nextVersion ? prev.dismissed : false }
}

/**
 * @param {UpdateViewState} prev
 * @returns {UpdateViewState}
 */
export function reduceDismissed(prev) {
  if (prev.dismissed) return prev
  return { status: prev.status, dismissed: true }
}

/**
 * @param {UpdateStatus} status
 * @returns {string | null}
 */
export function stagedVersion(status) {
  return status.state === UPDATE_STATE.READY ? status.nextVersion : null
}
