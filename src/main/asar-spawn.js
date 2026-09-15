// Asar redirects fs reads transparently but not child_process.spawn: a path that resolves into
// app.asar/ via require.resolve fails with ENOTDIR when handed to spawn. bare-sidecar (Sidecar
// constructor) spawns the bare binary and passes the worker entrypoint as argv, both resolved
// through require.asset, which returns asar paths. This translates them back to app.asar.unpacked
// so the OS sees real files. A no-op when not packaged or when a path is not under an asar.
//
// The install must run before any module that can reach bare-sidecar is loaded: the sidecar
// destructures `spawn` at load and keeps that reference, so a patch installed after it never
// applies. main.js therefore installs it ahead of every sibling require.

const childProcess = require('child_process')

function fixAsarPath(p) {
  return typeof p === 'string'
    ? p.replace(/([\\/])app\.asar([\\/])/g, '$1app.asar.unpacked$2')
    : p
}

// `target` is injectable so the wrapping is testable without patching the real module.
function installAsarSpawnFix(target = childProcess) {
  const spawn = target.spawn
  target.spawn = function (file, args, options) {
    file = fixAsarPath(file)
    if (Array.isArray(args)) args = args.map(fixAsarPath)
    return spawn.call(this, file, args, options)
  }
}

module.exports = { fixAsarPath, installAsarSpawnFix }
