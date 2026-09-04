'use strict'

const path = require('node:path')
const { WORKER_SPECS } = require('../shared/contract/workers.js')

// Resolved at boot (preloadAsarCache) so require.resolve runs while process.noAsar is still false.
// Resolving lazily would race the OTA updater's noAsar window and surface as MODULE_NOT_FOUND.
const entrypoints = new Map()

// `resolve` is injectable so the unit test can prove a refused specifier is never resolved at all.
function preloadEntrypoints (repoRoot, resolve = require.resolve) {
  entrypoints.clear()
  // Worker specifiers are repo-rooted ('/src/worker/main.js'); resolve against the package root so
  // the spec stays stable regardless of where in src/ the caller lives.
  for (const spec of WORKER_SPECS) entrypoints.set(spec, resolve(path.join(repoRoot, spec)))
}

// The allowlist IS the check. A miss used to fall through to
// `require.resolve(path.join(__dirname, '..', '..', specifier))`, so any string the renderer handed
// pear:startWorker became a path this process resolved and pear.run() executed — with the bootstrap
// frame (which ends in identityKEK) handed to it. The renderer is sandboxed and context-isolated,
// so reaching that needs renderer code execution first: defense in depth, not a live exploit. The
// fallthrough also never worked, for the noAsar reason above.
function entrypointFor (specifier) {
  const entrypoint = entrypoints.get(specifier)
  if (!entrypoint) throw new Error('refusing to spawn an unknown worker specifier: ' + specifier)
  return entrypoint
}

module.exports = { preloadEntrypoints, entrypointFor }
