// The update mode at work. It owns the stored mode (`updates.mode` in config.json) and carries the
// policy's answers to the three places that act on them: the updater's pass hook, the apply, and the
// status the windows show. A version the user approved downloads through a pass of its own.
//
// The mode has its own config group because main rewrites the `general` group whole from the record
// it keeps in memory, which would drop any key that record does not hold.
//
// No Electron here, so a Node test drives it against a real updater.
const { createUpdatePolicy } = require('./update-policy.js')
const { UPDATE_MODE, UPDATE_STATE } = require('../shared/contract/update-status.js')

const MODE_KEY = 'updates.mode'

// `prestages` is true where a staged update is put in place while the app runs (Windows, Linux);
// `runUserPass` starts a pass the user asked for.
function createUpdateModeControl({ running, config, status, getUpdater, prestages, runUserPass }) {
  const policy = createUpdatePolicy({ running, getMode: () => config().get(MODE_KEY) })
  // The version the pass in flight was let through to download, until the updater has staged it.
  let passTarget = null

  // The mode, and whether the update in flight or staged waits for the user. An update already
  // applied in place cannot wait any more.
  function syncStatus() {
    const u = getUpdater()
    const held = !u?.applied && !policy.mayInstall(passTarget ?? u?.nextVersion ?? null)
    status.dispatch({ type: 'policy', mode: policy.mode(), held })
  }

  function prestage(u) {
    if (!prestages || !policy.mayInstall(u.nextVersion)) return
    u.applyUpdate().catch((err) => console.error('background apply failed:', err))
  }

  function announceStaged(u) {
    syncStatus()
    status.dispatch({ type: 'ready', version: u.nextVersion })
    prestage(u)
  }

  return {
    syncStatus,

    // The updater's skipUpdate hook: true stops the pass before it downloads anything. A pass let
    // through to download an approved version leaves the status as the approval set it.
    async gatePass() {
      const decision = await policy.gate(getUpdater().drive)
      if (decision !== null && !decision.skip) {
        passTarget = decision.available
        syncStatus()
        return false
      }
      passTarget = null
      status.dispatch({ type: 'pass-start' })
      if (decision === null) return false
      status.dispatch({ type: 'available', version: decision.available })
      return true
    },

    // The updater finished staging a version.
    staged() {
      passTarget = null
      announceStaged(getUpdater())
    },

    mayApply() {
      return policy.mayInstall(getUpdater().nextVersion)
    },

    // The user's go-ahead for the version they were shown. One already staged is ready at once; any
    // other downloads now. False when no version is waiting.
    install() {
      const u = getUpdater()
      const { state, nextVersion } = status.get()
      if (state !== UPDATE_STATE.AVAILABLE || !nextVersion) return false
      policy.approve(nextVersion)
      if (u.updated && !u.applied && u.nextVersion === nextVersion) {
        announceStaged(u)
        return true
      }
      passTarget = nextVersion
      syncStatus()
      status.dispatch({ type: 'downloading' })
      runUserPass(u).catch((err) => console.error('update install failed:', err))
      return true
    },

    // A mode change takes effect at once: a staged update it no longer lets install waits, one it
    // now lets install is ready, and a version that waited downloads.
    changeMode(mode) {
      config().set(MODE_KEY, mode)
      syncStatus()
      const u = getUpdater()
      if (!u || mode !== UPDATE_MODE.AUTOMATIC) return
      if (u.updated && !u.applied) announceStaged(u)
      else if (status.get().state === UPDATE_STATE.AVAILABLE) {
        u._debouncedUpdate().catch((err) => console.error('update pass failed:', err))
      }
    },
  }
}

module.exports = { createUpdateModeControl }
