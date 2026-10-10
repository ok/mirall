const { app } = require('electron')
const pkg = require('../../package.json')

// MIRALL_* and PEAR_DEV_SERVER_URL are development and test levers. A packaged build ignores them,
// so a launch environment cannot change what a release does. Main reads every such variable
// through envOverride; the few that a release honours are listed in test/invariants/main-env-reads.test.js.
// The exception is a rig build (MIRALL_RIG_BUILD in forge.config.js), packaged for mirall-docs-rig
// and never released, whose bundled package.json carries `rigBuild: true`.
const allowEnvOverrides = !app.isPackaged || pkg.rigBuild === true

/** @param {string} name @returns {string | undefined} */
function envOverride(name) {
  return allowEnvOverrides ? process.env[name] : undefined
}

module.exports = { envOverride }
