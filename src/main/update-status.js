// The update status main reports to every window. A pass only counts as a check when it reached a
// peer of the update drive: a pass with no peers reads the local head and proves nothing. A
// background pass that reaches no one leaves the status as it was; a check the user asked for says
// it could not reach the network. A staged update stays `ready` until a newer one starts
// downloading. Download progress changes the status once per whole percent, not once per
// measurement, so the windows are not sent every tick of the updater's monitor.
const { UPDATE_STATE } = require('../shared/contract/update-status.js')

const NO_DOWNLOAD = Object.freeze({ progress: null, waitingForPeers: false })
// Only `ready` says the update is usable, so a download never reads as complete.
const MAX_PROGRESS = 99

function initialUpdateStatus({ offReason, canRestart }) {
  return {
    state: offReason ? UPDATE_STATE.OFF : UPDATE_STATE.IDLE,
    nextVersion: null,
    lastCheckedAt: null,
    offReason: offReason ?? null,
    canRestart,
    ...NO_DOWNLOAD,
  }
}

// A null fraction is a download that has not been sized yet.
function wholePercent(fraction) {
  return fraction === null ? null : Math.min(MAX_PROGRESS, Math.floor(fraction * 100))
}

function withProgress(prev, event) {
  if (prev.state !== UPDATE_STATE.DOWNLOADING) return prev
  const progress = wholePercent(event.fraction)
  const waitingForPeers = event.peers === 0
  if (progress === prev.progress && waitingForPeers === prev.waitingForPeers) return prev
  return { ...prev, progress, waitingForPeers }
}

function settled(prev, failed) {
  if (prev.state === UPDATE_STATE.READY) return prev.state
  return failed ? UPDATE_STATE.ERROR : UPDATE_STATE.IDLE
}

function reduceUpdateStatus(prev, event, now) {
  if (prev.state === UPDATE_STATE.OFF) return prev
  switch (event.type) {
    case 'pass-start':
      if (prev.state === UPDATE_STATE.READY || prev.state === UPDATE_STATE.CHECKING) return prev
      return { ...prev, state: UPDATE_STATE.CHECKING }
    case 'downloading':
      return { ...prev, ...NO_DOWNLOAD, state: UPDATE_STATE.DOWNLOADING }
    case 'progress':
      return withProgress(prev, event)
    case 'ready':
      return { ...prev, ...NO_DOWNLOAD, state: UPDATE_STATE.READY, nextVersion: event.version, lastCheckedAt: now }
    case 'pass-end':
      if (event.reached) return { ...prev, ...NO_DOWNLOAD, state: settled(prev, false), lastCheckedAt: now }
      return { ...prev, ...NO_DOWNLOAD, state: settled(prev, event.manual) }
    case 'pass-failed':
      return { ...prev, ...NO_DOWNLOAD, state: settled(prev, true) }
    default:
      return prev
  }
}

function createUpdateStatus(initial) {
  let status = initial
  const listeners = new Set()
  return {
    get: () => status,
    dispatch(event) {
      const next = reduceUpdateStatus(status, event, Date.now())
      if (next === status) return
      status = next
      for (const listener of listeners) listener(status)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

module.exports = { initialUpdateStatus, reduceUpdateStatus, createUpdateStatus }
