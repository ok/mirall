const { app } = require('electron')

// MIRALL_* and PEAR_DEV_SERVER_URL are development and test levers. A packaged build ignores them,
// so a launch environment cannot change what a release does. Main reads every such variable
// through envOverride; the few that a release honours are listed in test/invariants/main-env-reads.test.js.
const allowEnvOverrides = !app.isPackaged

/** @param {string} name @returns {string | undefined} */
function envOverride(name) {
  return allowEnvOverrides ? process.env[name] : undefined
}

module.exports = { envOverride }
