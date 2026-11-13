// Recursive watchers over mounted folders, one per key: an owned share's id, or a mirror's
// `spaceId:shareId`. The caller names the key and says where each event goes — this module knows
// neither kind.
//
// Everything watcher-shaped — the option bag, polling for network mounts, the error-storm
// cut-off — belongs to watch-host.js and is shared with loose-file-watchers.js. A root needs its
// own host rather than a shared one because `ignored` is a per-instance watcher option and each
// owned share's ignore patterns differ.
//
// The ignore globs are matched by the data layer's `shouldIgnore`, the same function the periodic
// reconcile's disk walk asks, so a path this watcher withholds is a path the reconcile withholds.
import path from 'bare-path'
import { DEFAULT_IGNORE, shouldIgnore, shouldPruneDir } from '../../shared/folders/path-keys.js'
import { createWatchHost } from './watch-host.js'
/** @import { WatchEnv } from './watch-host.js' */

/** @param {WatchEnv} env */
export function createFolderWatchers(env) {
  const watchers = new Map() // key -> { host, mountPath }

  // `ignorePatterns` null means the data layer's defaults — the partials and OS droppings no root
  // wants. A live key at the same path is kept; at another path it is re-made there.
  function start(key, mountPath, ignorePatterns, onEvent, onError) {
    const live = watchers.get(key)
    if (live && live.mountPath === mountPath) return
    if (live) stop(key)
    const patterns = ignorePatterns ?? DEFAULT_IGNORE
    // A directory is asked about as a directory — the watcher supplies the stats on the traversal
    // decision, and a glob naming a directory only answers for one when it is presented as one.
    const ignoreFn = (full, stats) => {
      if (full === mountPath) return false
      const rel = path.relative(mountPath, full)
      if (!rel) return false
      const relKey = rel.split(path.sep).join('/')
      if (stats && stats.isDirectory()) return shouldPruneDir(relKey, patterns)
      return shouldIgnore(relKey, patterns)
    }
    // atomic:false — the retire executor re-confirms presence (publish-runner's
    // fileExactlyPresent) and the periodic reconcile re-derives the truth, so coalescing an
    // unlink+add into a `change` would hide a genuine delete-then-create of a different file. A
    // mirror reacts to every action the same way, so it takes the same value. The loose side sets
    // true for the opposite reason; see loose-file-watchers.js.
    const host = createWatchHost({
      label: key,
      atomic: false,
      ignored: ignoreFn,
      onEvent: ({ action, absPath }) => {
        const relPath = path.relative(mountPath, absPath).split(path.sep).join('/')
        onEvent({ action, relPath, absPath })
      },
      onError,
      onStorm: () => { watchers.delete(key) },
    }, env)
    host.add(mountPath)
    watchers.set(key, { host, mountPath })
  }

  function stop(key) {
    const entry = watchers.get(key)
    if (!entry) return
    entry.host.stop()
    watchers.delete(key)
  }

  function stopAll() {
    for (const key of [...watchers.keys()]) stop(key)
  }

  /** @internal what a test asks: is this key watched, and where */
  function watchedPath(key) {
    return watchers.get(key)?.mountPath ?? null
  }

  return { start, stop, stopAll, watchedPath }
}
