// The update status main reports to every window. A pass only counts as a check when it reached a
// peer of the update drive: a pass with no peers reads the local head and proves nothing. A
// background pass that reaches no one leaves the status as it was; a check the user asked for says
// it could not reach the network. A staged update stays `ready` until a newer one starts
// downloading. Download progress changes the status once per whole percent, not once per
// measurement, so the windows are not sent every tick of the updater's monitor. A newer version
// that waits for the user's go-ahead is `available` and, like `ready`, survives later passes; an
// update that finishes downloading while it waits is reported as `available`, never `ready`.
const { UPDATE_STATE, UPDATE_MODE } = require('../shared/contract/update-status.js')

const NO_DOWNLOAD = Object.freeze({ progress: null, waitingForPeers: false })
// Only `ready` says the update is usable, so a download never reads as complete.
const MAX_PROGRESS = 99

function initialUpdateStatus({ offReason, canRestart, mode = UPDATE_MODE.AUTOMATIC }) {
  return {
    state: offReason ? UPDATE_STATE.OFF : UPDATE_STATE.IDLE,
    nextVersion: null,
    lastCheckedAt: null,
    offReason: offReason ?? null,
    canRestart,
    mode,
    held: false,
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

// The states a pass leaves alone: a staged update, and a newer version waiting for the user.
function isWaiting(state) {
  return state === UPDATE_STATE.READY || state === UPDATE_STATE.AVAILABLE
}

function settled(prev, failed) {
  if (isWaiting(prev.state)) return prev.state
  return failed ? UPDATE_STATE.ERROR : UPDATE_STATE.IDLE
}

// A staged update the policy no longer lets install goes back to waiting for the user.
function withPolicy(prev, { mode, held }) {
  if (prev.mode === mode && prev.held === held) return prev
  const state = held && prev.state === UPDATE_STATE.READY ? UPDATE_STATE.AVAILABLE : prev.state
  return { ...prev, mode, held, state }
}

function reduceUpdateStatus(prev, event, now) {
  if (prev.state === UPDATE_STATE.OFF) return prev
  switch (event.type) {
    case 'pass-start':
      if (isWaiting(prev.state) || prev.state === UPDATE_STATE.CHECKING) return prev
      return { ...prev, state: UPDATE_STATE.CHECKING }
    case 'downloading':
      return { ...prev, ...NO_DOWNLOAD, state: UPDATE_STATE.DOWNLOADING }
    case 'progress':
      return withProgress(prev, event)
    case 'ready':
      return { ...prev, ...NO_DOWNLOAD, state: prev.held ? UPDATE_STATE.AVAILABLE : UPDATE_STATE.READY, nextVersion: event.version, lastCheckedAt: now }
    case 'available':
      if (event.version === null) return prev.state === UPDATE_STATE.AVAILABLE ? { ...prev, state: UPDATE_STATE.IDLE, nextVersion: null } : prev
      if (prev.state === UPDATE_STATE.AVAILABLE && prev.nextVersion === event.version) return prev
      return { ...prev, ...NO_DOWNLOAD, state: UPDATE_STATE.AVAILABLE, nextVersion: event.version }
    case 'policy':
      return withPolicy(prev, event)
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
