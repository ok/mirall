// One watch host over a dynamic set of individual absolute file paths (in-place loose files
// are scattered, not under one root). The same file can be shared in several spaces, so each
// path maps to the set of spaces watching it and an event fans out to all of them. That
// fan-out is the only loose-specific logic here; polling for network paths, the error-storm
// cut-off and the watcher option bag belong to watch-host.js and are shared with
// folder-watchers.js.
import { createWatchHost } from './watch-host.js'
/** @import { WatchEnv } from './watch-host.js' */

/**
 * @param {WatchEnv} env
 * @param {{ onEvent: (event: { spaceId: string, absPath: string, action: string }) => void, onError: (err: Error) => void }} sinks
 */
export function createLooseFileWatchers(env, { onEvent, onError }) {
  let host = null
  const watched = new Map() // absPath -> Set<spaceId>

  function ensure() {
    if (host) return host
    // atomic:true — a loose entry is a single tracked path with no diff pass behind it, so an
    // editor that saves by rename-over must arrive as one `change`; a transient unlink would
    // tombstone the entry and un-share the file. The owned side sets false for the opposite
    // reason; see folder-watchers.js.
    host = createWatchHost({
      label: 'loose',
      atomic: true,
      onEvent: ({ action, absPath }) => {
        const spaces = watched.get(absPath)
        if (!spaces) return
        for (const spaceId of spaces) onEvent({ spaceId, absPath, action })
      },
      onError,
      // The host has already stopped itself. Drop the bookkeeping so the next armed path builds
      // a fresh host rather than adding to a dead one.
      onStorm: () => { host = null; watched.clear() },
    }, env)
    return host
  }

  function add(spaceId, absPath) {
    const live = ensure()
    let spaces = watched.get(absPath)
    if (!spaces) { live.add(absPath); watched.set(absPath, (spaces = new Set())) }
    spaces.add(spaceId)
  }

  function remove(spaceId, absPath) {
    const spaces = watched.get(absPath)
    if (!spaces) return
    spaces.delete(spaceId)
    if (spaces.size === 0) {
      watched.delete(absPath)
      if (host) host.remove(absPath)
    }
  }

  function stopAll() {
    if (host) host.stop()
    host = null
    watched.clear()
  }

  /** @internal what a test asks: which spaces watch this path */
  function spacesWatching(absPath) {
    return [...(watched.get(absPath) ?? [])]
  }

  return { add, remove, stopAll, spacesWatching }
}
