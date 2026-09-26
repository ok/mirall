// The single owner of the file watcher (chokidar4bare) in this process, shared by folder-watchers
// (one recursive root per share) and loose-file-watchers (scattered individual files). It owns the
// things every watcher caller has to get right: a network mount emits no native events (watch it by
// polling or not at all — a file there otherwise silently stops re-publishing, with no error, no
// badge, no log line), an erroring watcher spins for the life of the process (the storm guard), a
// watch the OS has no budget for is a degraded watcher rather than a failed one, and the option bag
// (only `atomic` and `ignored` vary per caller, each carrying its reason at the call site).
//
// Options are per-INSTANCE, not per-path, so `usePolling` cannot vary within one watcher. A host
// therefore holds up to two instances — native and polling — and routes each target by
// looksLikeNetworkPath. The polling instance is created lazily, so a user with no network paths
// pays nothing.
const chokidar4bare = require('chokidar4bare')
const { looksLikeNetworkPath } = require('../shared/contract/network-paths.js')

const ERROR_WINDOW_MS = 10_000
const ERROR_STORM_LIMIT = 5
const POLL_INTERVAL_MS = 5000
// A watch the OS refused for want of a resource: past the inotify limit (ENOSPC) or the open-file
// limit (EMFILE) the watcher raises one error per directory or file it could not arm, and keeps
// serving everything it did arm.
const WATCH_BUDGET_CODES = new Set(['ENOSPC', 'EMFILE'])
// Polling stats every watched path every interval. Not a cap — silently not watching is the
// defect this module exists to fix — just a single warning when the cost becomes worth knowing.
const POLL_TARGET_WARN = 200

/**
 * createWatchHost({
 *   label,                       // names the host in the storm message
 *   atomic,                      // owned: false, loose: true — deliberate, documented at both callers
 *   ignored,                     // the watcher's `ignored` predicate, or undefined
 *   onEvent({ action, absPath }),
 *   onError(err),
 *   onStorm(),                   // the host has already stopped itself; drop the caller's bookkeeping
 * })
 */
function createWatchHost({ label, atomic = false, ignored, onEvent, onError, onStorm }) {
  const instances = new Map() // 'native' | 'polling' -> watcher instance
  const errorWindow = []
  let degraded = false
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
    const watcher = chokidar4bare.watch([], optionsFor(mode))
    const handler = (action) => (absPath) => {
      if (!stopped) onEvent?.({ action, absPath })
    }
    watcher.on('add', handler('add'))
    watcher.on('change', handler('change'))
    watcher.on('unlink', handler('unlink'))
    watcher.on('error', onWatcherError)
    instances.set(mode, watcher)
    return watcher
  }

  // Budget errors are counted toward nothing: stopping the host would silence every directory it
  // did arm. One report per host says the watch is degraded; the storm guard sees only the rest.
  function onWatcherError(err) {
    if (WATCH_BUDGET_CODES.has(err?.code)) {
      if (degraded) return
      degraded = true
      // Under Bare the error carries only `code`; the path is named when the runtime supplies it.
      const where = err.path ? ' at ' + err.path : ''
      onError?.(new Error('watch-degraded: ' + label + ' - ' + err.code + where + ', paths past the OS watch limit are not watched'))
      return
    }
    onError?.(err)
    const now = Date.now()
    errorWindow.push(now)
    while (errorWindow.length && now - errorWindow[0] > ERROR_WINDOW_MS) errorWindow.shift()
    if (errorWindow.length > ERROR_STORM_LIMIT) {
      stop()
      onError?.(new Error('error-storm: watcher stopped for ' + label))
      onStorm?.()
    }
  }

  function modeFor(target) {
    return looksLikeNetworkPath(target, process.platform) ? 'polling' : 'native'
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
    const warnClose = (err) => console.warn(label, 'watcher.close failed -', err?.message)
    // close() settles asynchronously; a rejection is reported like a synchronous throw.
    for (const watcher of instances.values()) {
      try { Promise.resolve(watcher.close()).catch(warnClose) } catch (err) { warnClose(err) }
    }
    instances.clear()
    errorWindow.length = 0
    degraded = false
    pollTargets = 0
    pollWarned = false
  }

  return { add, remove, stop }
}

module.exports = { createWatchHost }
