// Recursive chokidar watchers over owned-folder mounts, one per share. They
// live in Electron main because the Bare worker has no recursive filesystem
// watch; add/change/unlink events are forwarded to the worker, which publishes
// the changes into the share catalog. Network-looking mounts fall back to
// polling, and a watcher that storms errors is stopped rather than left spinning.
const chokidar = require('chokidar')
const path = require('node:path')

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

function looksLikeNetworkPath(p) {
  if (!p) return false
  if (p.startsWith('\\\\')) return true
  if (process.platform === 'darwin' && p.startsWith('/Volumes/')) return true
  if (process.platform === 'linux' && (p.startsWith('/mnt/') || p.startsWith('/media/'))) return true
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

  const usePolling = looksLikeNetworkPath(mountPath)
  const watcher = chokidar.watch(mountPath, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 },
    atomic: false,
    ignored: ignoreFn,
    followSymlinks: false,
    usePolling,
    interval: usePolling ? 5000 : undefined,
    alwaysStat: true,
  })

  const errorWindow = []
  const handler = (action) => (abs) => {
    const rel = path.relative(mountPath, abs).split(path.sep).join('/')
    emitEvent?.({ shareId, action, relPath: rel, absPath: abs })
  }
  watcher.on('add', handler('add'))
  watcher.on('change', handler('change'))
  watcher.on('unlink', handler('unlink'))

  watcher.on('error', (err) => {
    emitError?.(err)
    const now = Date.now()
    errorWindow.push(now)
    while (errorWindow.length && now - errorWindow[0] > 10_000) errorWindow.shift()
    if (errorWindow.length > 5) {
      stopWatcher(shareId)
      emitError?.(new Error('error-storm: watcher stopped for ' + shareId))
    }
  })

  watchers.set(shareId, { watcher, mountPath })
}

function stopWatcher(shareId) {
  const entry = watchers.get(shareId)
  if (!entry) return
  try { entry.watcher.close() } catch (err) {
    console.warn('watcher.close failed for', shareId, '-', err.message)
  }
  watchers.delete(shareId)
}

function stopAllWatchers() {
  for (const shareId of [...watchers.keys()]) stopWatcher(shareId)
}

module.exports = { startWatcher, stopWatcher, stopAllWatchers }
