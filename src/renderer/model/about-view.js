// What About and the Profile row say about the running build and its updates. Green is earned: only
// a check that reached the update network says "up to date"; a status that proves nothing shows the
// version alone.
import { UPDATE_STATE, UPDATES_OFF_REASON } from '../../shared/contract/update-status.js'

/**
 * @import { UpdateStatus } from '../../shared/contract/update-status.js'
 * @typedef {'up-to-date' | 'ready' | 'neutral'} UpdateLamp
 * @typedef {'check' | 'restart' | null} UpdateAction
 * @typedef {'release' | 'beta' | 'dev' | 'source'} ReleaseChannel
 */

/** @param {UpdateStatus} status @returns {{ lamp: UpdateLamp, key: string, action: UpdateAction }} */
export function updateVerdict(status) {
  switch (status.state) {
    case UPDATE_STATE.OFF:
      return { lamp: 'neutral', key: status.offReason === UPDATES_OFF_REASON.DEB_INSTALL ? 'offDeb' : 'off', action: null }
    case UPDATE_STATE.CHECKING:
      return { lamp: 'neutral', key: 'checking', action: 'check' }
    case UPDATE_STATE.DOWNLOADING:
      return { lamp: 'neutral', key: 'downloading', action: null }
    case UPDATE_STATE.READY:
      return { lamp: 'ready', key: 'ready', action: status.canRestart ? 'restart' : null }
    case UPDATE_STATE.ERROR:
      return { lamp: 'neutral', key: 'error', action: 'check' }
    default:
      return status.lastCheckedAt === null
        ? { lamp: 'neutral', key: 'notChecked', action: 'check' }
        : { lamp: 'up-to-date', key: 'upToDate', action: 'check' }
  }
}

/** @param {UpdateStatus} status @returns {Exclude<UpdateLamp, 'neutral'> | null} */
export function updateDot(status) {
  const { lamp } = updateVerdict(status)
  return lamp === 'neutral' ? null : lamp
}

// The Profile row's line after the version, or null when the status proves nothing worth saying.
/** @param {UpdateStatus} status @returns {string | null} */
export function updateSummaryKey(status) {
  const { key } = updateVerdict(status)
  if (key === 'notChecked' || key === 'error' || key === 'off') return null
  return `about.summary.${key}`
}

/** @param {string} version @param {boolean} isDev @returns {ReleaseChannel} */
export function releaseChannel(version, isDev) {
  if (isDev) return 'source'
  if (/-dev\.\d+$/.test(version)) return 'dev'
  if (/-beta\.\d+$/.test(version)) return 'beta'
  return 'release'
}
