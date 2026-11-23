// Which update work runs without the user. In `automatic` mode every pass downloads and every staged
// update installs. In `notify` a newer version is reported and waits: none of its bytes are fetched
// and nothing is installed until the user approves that exact version.
//
// The updater runs `gate` before each pass (its `skipUpdate` hook) and asks `mayInstall` before each
// apply; the apply check is what keeps an update that finished downloading before the mode changed
// from installing anyway.
//
// No Electron here, so a Node test drives it against a real updater.
const semver = require('bare-semver')
const { UPDATE_MODE, normalizeUpdateMode } = require('../shared/contract/update-status.js')

function isNewer(remote, running) {
  try {
    return semver.Version.parse(running).compare(semver.Version.parse(remote)) < 0
  } catch {
    return false
  }
}

// The version the update drive offers now: its head's /package.json, which is all a check reads.
async function readRemoteVersion(drive) {
  await drive.update()
  if (!drive.core.length) return null
  const co = drive.checkout(drive.core.length)
  try {
    const manifest = await co.get('/package.json')
    return manifest ? JSON.parse(manifest.toString()).version ?? null : null
  } catch (err) {
    if (err instanceof SyntaxError) return null
    throw err
  } finally {
    await co.close()
  }
}

/**
 * What a non-automatic pass does once the offered version is known: `available` is the newer version
 * to report (null when the running build is current), `skip` stops the pass before it downloads.
 * @param {{ remote: string | null, running: string, approved: string | null }} facts
 * @returns {{ skip: boolean, available: string | null }}
 */
function passDecision({ remote, running, approved }) {
  const available = remote && isNewer(remote, running) ? remote : null
  return { skip: available === null || available !== approved, available }
}

function createUpdatePolicy({ running, getMode }) {
  let approved = null
  const mode = () => normalizeUpdateMode(getMode())

  return {
    mode,
    approve(version) {
      approved = version
    },
    // Null when the pass runs as the updater would run it; otherwise the decision for this pass.
    async gate(drive) {
      if (mode() === UPDATE_MODE.AUTOMATIC) return null
      return passDecision({ remote: await readRemoteVersion(drive), running, approved })
    },
    mayInstall(version) {
      return mode() === UPDATE_MODE.AUTOMATIC || (version !== null && version === approved)
    },
  }
}

module.exports = { createUpdatePolicy, passDecision }
