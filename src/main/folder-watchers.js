// Recursive watchers over mounted folders, one per key: an owned share's id, or a mirror's
// `spaceId:shareId`. They live in Electron main because the Bare worker has no recursive
// filesystem watch; add/change/unlink events are forwarded to the worker, which publishes an owned
// folder's changes into the share catalog and asks a mirror's loop to re-walk. The caller names
// the key and builds the frame — this module knows neither kind.
//
// Everything chokidar-shaped — the option bag, polling for network mounts, the error-storm
// cut-off — belongs to watch-host.js and is shared with loose-file-watchers.js. A root needs its
// own host rather than a shared one because `ignored` is a per-instance chokidar option and each
// owned share's ignore patterns differ.
//
// The ignore globs are matched by the data layer's `shouldIgnore`, the same function the periodic
// reconcile's disk walk asks, so a path this watcher withholds is a path the reconcile withholds.
// The data layer is ESM, which a CommonJS main reaches with a dynamic import (as notifications.js
// does for the reveal authorization check).
const path = require('node:path')
const { createWatchHost } = require('./watch-host.js')

const pathKeys = import('../shared/folders/path-keys.js').catch((err) => {
  console.error('[folder-watchers] path-keys import failed, watching disabled:', err.message)
  return null
})

const watchers = new Map() // key -> { host, mountPath, onEvent, onError }

// The newest caller owns a live key: on a worker respawn the new worker re-issues start-watcher
// for a key whose chokidar watcher is still alive, and the surviving watcher must deliver to the
// new worker's closure, not the dead one's. A live key at another path is a stop-watcher that never
// arrived (the worker died between a relocate's record write and its stop), so the root is re-made.
function adopt(key, mountPath, onEvent, onError) {
  const live = watchers.get(key)
  if (!live) return false
  if (live.mountPath !== mountPath) {
    stopWatcher(key)
    return false
  }
  live.onEvent = onEvent
  live.onError = onError
  return true
}

// `ignorePatterns` null means the data layer's defaults — the partials and OS droppings no root
// wants — which only the imported module can name.
async function startWatcher(key, mountPath, ignorePatterns, onEvent, onError) {
  if (adopt(key, mountPath, onEvent, onError)) return
  const mod = await pathKeys
  // No matcher, no watcher: arming one that ignores nothing would publish exactly the paths the
  // share's globs exist to withhold. The reconcile still re-derives the share from disk.
  if (!mod) return onError?.(new Error('ignore matcher unavailable - watcher not started'))
  // The await above is a second window for a concurrent start-watcher for this key, and the
  // newest caller owns it there too.
  if (adopt(key, mountPath, onEvent, onError)) return
  const patterns = ignorePatterns ?? mod.DEFAULT_IGNORE
  // A directory is asked about as a directory — chokidar supplies the stats on the traversal
  // decision, and a glob naming a directory only answers for one when it is presented as one.
  const ignoreFn = (full, stats) => {
    if (full === mountPath) return false
    const rel = path.relative(mountPath, full)
    if (!rel) return false
    const relKey = rel.split(path.sep).join('/')
    if (stats && stats.isDirectory()) return mod.shouldPruneDir(relKey, patterns)
    return mod.shouldIgnore(relKey, patterns)
  }
  const entry = { host: null, mountPath, onEvent, onError }
  // atomic:false — the retire executor re-confirms presence (publish-runner's
  // fileExactlyPresent) and the periodic reconcile re-derives the truth, so coalescing an
  // unlink+add into a `change` would hide a genuine delete-then-create of a different file. A
  // mirror reacts to every action the same way, so it takes the same value. The loose side sets
  // true for the opposite reason; see loose-file-watchers.js.
  entry.host = createWatchHost({
    label: key,
    atomic: false,
    ignored: ignoreFn,
    onEvent: ({ action, absPath }) => {
      const relPath = path.relative(mountPath, absPath).split(path.sep).join('/')
      entry.onEvent?.({ action, relPath, absPath })
    },
    onError: (err) => entry.onError?.(err),
    onStorm: () => { watchers.delete(key) },
  })
  entry.host.add(mountPath)
  watchers.set(key, entry)
}

function stopWatcher(key) {
  const entry = watchers.get(key)
  if (!entry) return
  entry.host.stop()
  watchers.delete(key)
}

function stopAllWatchers() {
  for (const key of [...watchers.keys()]) stopWatcher(key)
}

module.exports = { startWatcher, stopWatcher, stopAllWatchers }
