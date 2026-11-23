// A stand-in updater for a development run, which has no update drive to follow. It offers one
// version and walks the same mode control, policy and status the real updater does, so the update
// screens can be seen and driven: a check finds the version, a download takes a few seconds, and
// "installing" changes nothing on disk. Main builds one only under the MIRALL_UPDATE_PREVIEW lever.
//
// No Electron here, so a Node test drives it.
const debounceify = require('debounceify')

const DOWNLOAD_STEPS = 20
const DEFAULT_STEP_MS = 300

function createPreviewUpdater({ version, status, control, stepMs = DEFAULT_STEP_MS }) {
  const manifest = Buffer.from(JSON.stringify({ version }))
  const updater = {
    updated: false,
    applied: false,
    nextVersion: null,
    // What a check reads: a drive whose head offers `version`, reached through one peer.
    drive: {
      update: async () => {},
      core: { length: 1, fork: 0, peers: [null] },
      checkout: () => ({ get: async () => manifest, close: async () => {} }),
    },
    async applyUpdate() {
      updater.applied = true
    },
  }

  async function pass() {
    try {
      if ((await control.gatePass()) || updater.updated) return
      status.dispatch({ type: 'downloading' })
      for (let step = 1; step <= DOWNLOAD_STEPS; step++) {
        await new Promise((resolve) => setTimeout(resolve, stepMs))
        status.dispatch({ type: 'progress', fraction: step / DOWNLOAD_STEPS, peers: 1 })
      }
      updater.updated = true
      updater.nextVersion = version
      control.staged()
    } finally {
      status.dispatch({ type: 'pass-end', reached: true, manual: false })
    }
  }
  updater._debouncedUpdate = debounceify(pass)

  return updater
}

module.exports = { createPreviewUpdater }
