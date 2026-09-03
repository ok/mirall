// The single owner of chokidar in this process. Two watcher modules sit on it —
// owned-folder-watchers (one recursive root per share) and loose-file-watchers (a scattered
// set of individual files) — because the three things chokidar makes you learn were learned
// once on the owned side and never carried across:
//
//   1. Native filesystem events do not reach a network mount, so a watch there emits nothing
//      at all. A file on one silently stops re-publishing: no error, no badge, no log line.
//   2. An erroring watcher otherwise spins for the life of the process.
//   3. The option bag itself, which drifted between the two callers.
//
// Options are per-INSTANCE in chokidar, not per-path, so `usePolling` cannot vary within one
// watcher. A host therefore holds up to two instances — native and polling — and routes each
// target by looksLikeNetworkPath. The polling instance is created lazily, so a user with no
// network paths pays nothing. Only `atomic` and `ignored` vary per caller; both carry their
// reason at the call site.
const chokidar = require('chokidar')

const ERROR_WINDOW_MS = 10_000
const ERROR_STORM_LIMIT = 5
const POLL_INTERVAL_MS = 5000
// Polling stats every watched path every interval. Not a cap — silently not watching is the
// defect this module exists to fix — just a single warning when the cost becomes worth knowing.
const POLL_TARGET_WARN = 200

// A path on a network mount is watched by polling or not at all. This predicate is the whole
// difference between a file that re-publishes on edit and one that quietly stops.
function looksLikeNetworkPath(p) {
  if (!p) return false
  if (p.startsWith('\\\\')) return true
  if (process.platform === 'darwin' && p.startsWith('/Volumes/')) return true
  if (process.platform === 'linux' && (p.startsWith('/mnt/') || p.startsWith('/media/'))) return true
  return false
}

/**
 * createWatchHost({
 *   label,                       // names the host in the storm message
 *   atomic,                      // owned: false, loose: true — deliberate, documented at both callers
 *   ignored,                     // chokidar `ignored` predicate, or undefined
 *   onEvent({ action, absPath }),
 *   onError(err),
 *   onStorm(),                   // the host has already stopped itself; drop the caller's bookkeeping
 * })
 */
function createWatchHost({ label, atomic = false, ignored, onEvent, onError, onStorm }) {
  const instances = new Map() // 'native' | 'polling' -> chokidar instance
  const errorWindow = []
  let pollTargets = 0
  let pollWarned = false
  let stopped = false

  function optionsFor(mode) {
    const opts = {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 },
      atomic,
      followSymlinks: false,
      alwaysStat: true,
    }
    if (ignored) opts.ignored = ignored
    if (mode === 'polling') {
      opts.usePolling = true
      opts.interval = POLL_INTERVAL_MS
    } else {
      opts.usePolling = false
    }
    return opts
  }

  function instance(mode) {
    const existing = instances.get(mode)
    if (existing) return existing
    const watcher = chokidar.watch([], optionsFor(mode))
    const handler = (action) => (absPath) => {
      if (!stopped) onEvent?.({ action, absPath })
    }
    watcher.on('add', handler('add'))
    watcher.on('change', handler('change'))
    watcher.on('unlink', handler('unlink'))
    watcher.on('error', (err) => {
      onError?.(err)
      const now = Date.now()
      errorWindow.push(now)
      while (errorWindow.length && now - errorWindow[0] > ERROR_WINDOW_MS) errorWindow.shift()
      if (errorWindow.length > ERROR_STORM_LIMIT) {
        stop()
        onError?.(new Error('error-storm: watcher stopped for ' + label))
        onStorm?.()
      }
    })
    instances.set(mode, watcher)
    return watcher
  }

  function modeFor(target) {
    return looksLikeNetworkPath(target) ? 'polling' : 'native'
  }

  function add(target) {
    if (stopped) return
    const mode = modeFor(target)
    if (mode === 'polling') {
      pollTargets++
      if (pollTargets > POLL_TARGET_WARN && !pollWarned) {
        pollWarned = true
        console.warn(label, 'watch host is polling', pollTargets, 'network targets every', POLL_INTERVAL_MS, 'ms')
      }
    }
    instance(mode).add(target)
  }

  function remove(target) {
    const mode = modeFor(target)
    if (mode === 'polling' && pollTargets > 0) pollTargets--
    const watcher = instances.get(mode)
    if (!watcher) return
    try { watcher.unwatch(target) } catch (err) {
      console.warn(label, 'watcher.unwatch failed for', target, '-', err.message)
    }
  }

  function stop() {
    stopped = true
    for (const watcher of instances.values()) {
      try { watcher.close() } catch (err) {
        console.warn(label, 'watcher.close failed -', err.message)
      }
    }
    instances.clear()
    errorWindow.length = 0
    pollTargets = 0
    pollWarned = false
  }

  return { add, remove, stop }
}

module.exports = { createWatchHost, looksLikeNetworkPath }
