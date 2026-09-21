'use strict'

const path = require('node:path')
const { MAIN_REQUEST } = require('../shared/contract/main-requests.js')

// The worker→main control bus. Keyed off the contract constants rather than string literals, so a
// rename that touches only one process cannot pass main-request-parity.test.js.
//
// The `else` matters as much as the table: an unrecognised command must warn, because a silent
// no-op here is an owned folder that stops re-publishing. A recognised command that threw is as
// silent unless it is said too. Both warn through keyedWarner.
const WARN_CAP = 16
const WARN_WINDOW_MS = 600000

// Once per key per window, over at most WARN_CAP live keys: a worker retrying the same frame would
// otherwise write one warning per frame into the fixed-size log ring and evict the diagnostics
// around it, and the cap covers a stream of DISTINCT keys. The window re-arms a key, so a failure
// that returns hours later is said again after the ring has long evicted the first line.
function keyedWarner({ overflow, now }) {
  const lastAt = new Map()
  let overflowAt = -Infinity
  return (key, ...line) => {
    const at = now()
    const last = lastAt.get(key)
    if (last !== undefined && at - last < WARN_WINDOW_MS) return
    if (last === undefined && lastAt.size >= WARN_CAP) {
      for (const [k, ts] of lastAt) if (at - ts >= WARN_WINDOW_MS) lastAt.delete(k)
      if (lastAt.size >= WARN_CAP) {
        if (at - overflowAt >= WARN_WINDOW_MS) {
          overflowAt = at
          console.warn(overflow)
        }
        return
      }
    }
    lastAt.set(key, at)
    console.warn(...line)
  }
}

const keyPart = (value) => (typeof value === 'string' ? value : typeof value)

function createMainRequestRouter({ ownedFolderWatchers, looseFileWatchers, setDownloadRoots, sendToWorker, now = Date.now }) {
  // Null-prototype, because `command` comes off the worker pipe: with a plain object literal
  // `handlers['toString']` finds Object.prototype's method and the frame resolves as though it had
  // been routed — the silent success this bus exists to remove.
  const handlers = Object.assign(Object.create(null), {
    [MAIN_REQUEST.DOWNLOADS_ROOTS]: async (args) => {
      setDownloadRoots(Array.isArray(args?.roots)
        ? args.roots.filter((r) => typeof r === 'string' && r.length > 0).map((r) => path.resolve(r))
        : [])
    },

    [MAIN_REQUEST.LOOSE_FILE_WATCH]: async (args, worker) => {
      looseFileWatchers.addLooseWatch(
        args.spaceId,
        args.absPath,
        (event) => sendToWorker(worker, { type: 'event:loose-file-fs-event', ...event }),
        // Not behind `debug`: console.warn feeds the log ring unconditionally, and the
        // error-storm message is the one signal saying this file stopped syncing and will not
        // resume on its own. Behind the flag it never reaches a user's diagnostics bundle.
        (err) => { console.warn('loose watcher error', args.absPath, '-', err.message) },
      )
    },

    [MAIN_REQUEST.LOOSE_FILE_UNWATCH]: async (args) => {
      looseFileWatchers.removeLooseWatch(args.spaceId, args.absPath)
    },

    [MAIN_REQUEST.OWNED_FOLDER_START_WATCHER]: async (args, worker) => {
      await ownedFolderWatchers.startWatcher(
        args.shareId,
        args.mountPath,
        args.ignore || [],
        (event) => sendToWorker(worker, { type: 'event:owned-folder-fs-event', ...event }),
        // See the loose-file callback above: the storm message must reach the log ring on a
        // release build, or the report it explains is unreproducible.
        (err) => { console.warn('watcher error', args.shareId, '-', err.message) },
      )
    },

    [MAIN_REQUEST.OWNED_FOLDER_STOP_WATCHER]: async (args) => {
      ownedFolderWatchers.stopWatcher(args.shareId)
    },
  })

  const warnUnknown = keyedWarner({ overflow: '[main-request] too many distinct unknown commands - no longer logging them', now })
  const warnFailure = keyedWarner({ overflow: '[main-request] too many distinct failures - no longer logging them', now })

  // Not behind `debug`, for the same reason as the watcher storm warnings: these lines are the only
  // signal that a watcher was never armed.
  function reportUnknown(command) {
    const name = keyPart(command)
    warnUnknown(name, '[main-request] unknown command:', name, '- nothing was done')
  }

  function reportFailure(command, err) {
    const name = keyPart(command)
    const code = keyPart(err?.code || err?.name || 'Error')
    warnFailure(name + ':' + code, '[main-request] failed:', name, '-', err?.message, '- repeats with this code are not logged for a while')
  }

  return {
    // The set main actually serves — read by the parity test, not by production code.
    commands: Object.freeze(Object.keys(handlers)),
    reportFailure,

    async handle(command, args, worker) {
      const fn = handlers[command]
      if (!fn) { reportUnknown(command); return }
      await fn(args, worker)
    },
  }
}

module.exports = { createMainRequestRouter }
