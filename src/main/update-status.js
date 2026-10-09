// The update status main reports to every window. A pass only counts as a check when it reached a
// peer of the update drive: a pass with no peers reads the local head and proves nothing. A
// background pass that reaches no one leaves the status as it was; a check the user asked for says
// it could not reach the network. A staged update stays `ready` until a newer one starts
// downloading.
const { UPDATE_STATE } = require('../shared/contract/update-status.js')

function initialUpdateStatus({ offReason, canRestart }) {
  return {
    state: offReason ? UPDATE_STATE.OFF : UPDATE_STATE.IDLE,
    nextVersion: null,
    lastCheckedAt: null,
    offReason: offReason ?? null,
    canRestart,
  }
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
      return { ...prev, state: UPDATE_STATE.DOWNLOADING }
    case 'ready':
      return { ...prev, state: UPDATE_STATE.READY, nextVersion: event.version, lastCheckedAt: now }
    case 'pass-end':
      if (event.reached) return { ...prev, state: settled(prev, false), lastCheckedAt: now }
      return { ...prev, state: settled(prev, event.manual) }
    case 'pass-failed':
      return { ...prev, state: settled(prev, true) }
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
