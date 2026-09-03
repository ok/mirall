// One watch host over a dynamic set of individual absolute file paths (in-place loose files
// are scattered, not under one root). The same file can be shared in several spaces, so each
// path maps to the set of spaces watching it and an event fans out to all of them. That
// fan-out is the only loose-specific logic here; polling for network paths, the error-storm
// cut-off and the chokidar option bag belong to watch-host.js and are shared with
// owned-folder-watchers.js.
const { createWatchHost } = require('./watch-host.js')

let host = null
const watched = new Map()
let emitEvent = null
let emitError = null

function ensure () {
  if (host) return
  // atomic:true — a loose entry is a single tracked path with no diff pass behind it, so an
  // editor that saves by rename-over must arrive as one `change`; a transient unlink would
  // tombstone the entry and un-share the file. The owned side sets false for the opposite
  // reason; see owned-folder-watchers.js.
  host = createWatchHost({
    label: 'loose',
    atomic: true,
    onEvent: ({ action, absPath }) => {
      const spaces = watched.get(absPath)
      if (!spaces || !emitEvent) return
      for (const spaceId of spaces) emitEvent({ spaceId, absPath, action })
    },
    onError: (err) => { if (emitError) emitError(err) },
    // The host has already stopped itself. Drop the bookkeeping so the next armed path builds
    // a fresh host rather than adding to a dead one.
    onStorm: () => { host = null; watched.clear() },
  })
}

function addLooseWatch (spaceId, absPath, onEvent, onError) {
  emitEvent = onEvent
  emitError = onError
  ensure()
  let spaces = watched.get(absPath)
  if (!spaces) { watched.set(absPath, (spaces = new Set())); host.add(absPath) }
  spaces.add(spaceId)
}

function removeLooseWatch (spaceId, absPath) {
  const spaces = watched.get(absPath)
  if (!spaces) return
  spaces.delete(spaceId)
  if (spaces.size === 0) {
    watched.delete(absPath)
    if (host) host.remove(absPath)
  }
}

function stopLooseWatchers () {
  if (host) host.stop()
  host = null
  watched.clear()
  emitEvent = null
  emitError = null
}

module.exports = { addLooseWatch, removeLooseWatch, stopLooseWatchers }
