// The renderer's view of main's update status, plus the banner's dismissal. The banner shows while
// an update is staged, or waits for the user's go-ahead, and is not dismissed; About ignores the
// dismissal. A different version, or the same one moving from waiting to staged, clears it, so each
// is announced once.
import { UPDATE_STATE, UPDATE_MODE } from '../../shared/contract/update-status.js'

/**
 * @import { UpdateStatus } from '../../shared/contract/update-status.js'
 * @typedef {{ status: UpdateStatus, dismissed: boolean }} UpdateViewState
 * @typedef {{ kind: 'ready' | 'available', version: string }} BannerUpdate
 */

/** @type {UpdateViewState} */
export const initialUpdateState = {
  status: { state: UPDATE_STATE.IDLE, nextVersion: null, lastCheckedAt: null, offReason: null, canRestart: false, progress: null, waitingForPeers: false, mode: UPDATE_MODE.AUTOMATIC, held: false },
  dismissed: false,
}

/**
 * @param {UpdateViewState} prev
 * @param {UpdateStatus} status
 * @returns {UpdateViewState}
 */
export function reduceStatus(prev, status) {
  return { status, dismissed: bannerKey(status) === bannerKey(prev.status) ? prev.dismissed : false }
}

/** @param {UpdateStatus} status */
function bannerKey(status) {
  const banner = bannerUpdate(status)
  return banner ? `${banner.kind}:${banner.version}` : null
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
 * What the banner announces: a staged update, or one waiting for the user's go-ahead.
 * @param {UpdateStatus} status
 * @returns {BannerUpdate | null}
 */
export function bannerUpdate(status) {
  if (!status.nextVersion) return null
  if (status.state === UPDATE_STATE.READY) return { kind: 'ready', version: status.nextVersion }
  if (status.state === UPDATE_STATE.AVAILABLE) return { kind: 'available', version: status.nextVersion }
  return null
}
