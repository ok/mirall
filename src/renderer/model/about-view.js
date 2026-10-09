// What About and the Profile row say about the running build and its updates. Green is earned: only
// a check that reached the update network says "up to date"; a status that proves nothing shows the
// version alone.
import { UPDATE_STATE, UPDATES_OFF_REASON } from '../../shared/contract/update-status.js'

/**
 * @import { UpdateStatus } from '../../shared/contract/update-status.js'
 * @import { SystemInfo } from '../platform/global.js'
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

/** @param {string} osVersion @returns {string} */
function windowsName(osVersion) {
  const build = Number(osVersion.split('.')[2])
  return build >= 22000 ? 'Windows 11' : 'Windows 10'
}

/** @param {SystemInfo} info @returns {string} */
export function osLabel(info) {
  if (info.platform === 'darwin') return `macOS ${info.osVersion}`
  if (info.platform === 'win32') return `${windowsName(info.osVersion)} (${info.osVersion})`
  if (info.platform === 'linux') return `Linux ${info.osVersion}`
  return `${info.platform} ${info.osVersion}`
}

/** @param {SystemInfo} info @returns {string} */
export function archLabel(info) {
  if (info.platform === 'darwin') return info.arch === 'arm64' ? 'Apple silicon' : 'Intel'
  return info.arch
}

// One line a support request can carry: the exact build and the system it runs on.
/** @param {string} version @param {SystemInfo} info @returns {string} */
export function appInfoLine(version, info) {
  return `Mirall ${version} · ${osLabel(info)} (${info.arch})`
}
