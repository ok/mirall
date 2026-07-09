const chokidar = require('chokidar')

// One watcher over a dynamic set of individual absolute file paths (in-place loose
// files are scattered, not under one root). The same file can be shared in several
// spaces, so each path maps to the set of spaces watching it and an event fans out
// to all of them. followSymlinks is off so the path reported back is exactly the
// one armed (matches owned-folder-watchers).
let watcher = null
const watched = new Map()
let emitEvent = null
let emitError = null

function ensure () {
  if (watcher) return
  watcher = chokidar.watch([], {
    ignoreInitial: true,
    alwaysStat: true,
    awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 },
    atomic: true,
    followSymlinks: false,
  })
  const handler = (action) => (abs) => {
    const spaces = watched.get(abs)
    if (!spaces || !emitEvent) return
    for (const spaceId of spaces) emitEvent({ spaceId, absPath: abs, action })
  }
  watcher.on('add', handler('add'))
  watcher.on('change', handler('change'))
  watcher.on('unlink', handler('unlink'))
  watcher.on('error', (err) => { if (emitError) emitError(err) })
}

function addLooseWatch (spaceId, absPath, onEvent, onError) {
  emitEvent = onEvent
  emitError = onError
  ensure()
  let spaces = watched.get(absPath)
  if (!spaces) { watched.set(absPath, (spaces = new Set())); watcher.add(absPath) }
  spaces.add(spaceId)
}

function removeLooseWatch (spaceId, absPath) {
  const spaces = watched.get(absPath)
  if (!spaces) return
  spaces.delete(spaceId)
  if (spaces.size === 0) {
    watched.delete(absPath)
    if (watcher) watcher.unwatch(absPath)
  }
}

function stopLooseWatchers () {
  if (watcher) { try { watcher.close() } catch (err) { console.warn('loose watcher.close failed -', err.message) } }
  watcher = null
  watched.clear()
  emitEvent = null
  emitError = null
}

module.exports = { addLooseWatch, removeLooseWatch, stopLooseWatchers }
