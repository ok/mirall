// Recursive watchers over owned-folder mounts, one per share. They live in Electron main
// because the Bare worker has no recursive filesystem watch; add/change/unlink events are
// forwarded to the worker, which publishes the changes into the share catalog.
//
// Everything chokidar-shaped — the option bag, polling for network mounts, the error-storm
// cut-off — belongs to watch-host.js and is shared with loose-file-watchers.js. A share needs
// its own host rather than a shared one because `ignored` is a per-instance chokidar option
// and each share's ignore patterns differ.
const path = require('node:path')
const { createWatchHost } = require('./watch-host.js')

const watchers = new Map()
let emitEvent = null
let emitError = null

function defaultIgnore(name, ignorePatterns) {
  if (!ignorePatterns || ignorePatterns.length === 0) return false
  const base = path.basename(name)
  for (const pat of ignorePatterns) {
    if (pat === base || pat === name) return true
    if (pat.endsWith('/**')) {
      const prefix = pat.slice(0, -3)
      if (base === prefix || name.includes('/' + prefix + '/') || name.endsWith('/' + prefix)) return true
    }
    if (pat.startsWith('*')) {
      if (base.endsWith(pat.slice(1))) return true
    }
  }
  return false
}

function startWatcher(shareId, mountPath, ignorePatterns, onEvent, onError) {
  // Re-point BEFORE the has()-guard: on a worker respawn the new worker re-issues
  // start-watcher for a shareId whose chokidar watcher is still alive; without this the
  // surviving watcher would keep delivering to the dead worker's write closure.
  emitEvent = onEvent
  emitError = onError
  if (watchers.has(shareId)) return
  const ignoreFn = (full) => {
    if (full === mountPath) return false
    const rel = path.relative(mountPath, full)
    if (!rel) return false
    return defaultIgnore(rel.split(path.sep).join('/'), ignorePatterns)
  }
  // atomic:false — the retire executor re-confirms presence (publish-runner's
  // fileExactlyPresent) and the periodic reconcile re-derives the truth, so coalescing an
  // unlink+add into a `change` would hide a genuine delete-then-create of a different file.
  // The loose side sets true for the opposite reason; see loose-file-watchers.js.
  const host = createWatchHost({
    label: shareId,
    atomic: false,
    ignored: ignoreFn,
    onEvent: ({ action, absPath }) => {
      const rel = path.relative(mountPath, absPath).split(path.sep).join('/')
      emitEvent?.({ shareId, action, relPath: rel, absPath })
    },
    onError: (err) => emitError?.(err),
    onStorm: () => { watchers.delete(shareId) },
  })
  host.add(mountPath)
  watchers.set(shareId, { host, mountPath })
}

function stopWatcher(shareId) {
  const entry = watchers.get(shareId)
  if (!entry) return
  entry.host.stop()
  watchers.delete(shareId)
}

function stopAllWatchers() {
  for (const shareId of [...watchers.keys()]) stopWatcher(shareId)
}

module.exports = { startWatcher, stopWatcher, stopAllWatchers }
