'use strict'

const path = require('node:path')
const { MAIN_REQUEST } = require('../shared/contract/main-requests.js')
const { createFailureGate } = require('./worker-bus-failure.js')

// The worker→main control bus. Keyed off the contract constants rather than string literals, so a
// rename that touches only one process cannot pass main-request-parity.test.js.
//
// An unrecognised command and a recognised one that threw are both failures, reported under the
// policy at `dispatch`: a silent no-op here is an owned folder that stops re-publishing.
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

// A mirror's watcher is keyed by its mount pair; an owned share's by its id alone.
const mirrorWatchKey = (args) => args.spaceId + ':' + args.shareId

function createMainRequestRouter({ folderWatchers, looseFileWatchers, setDownloadRoots, sendToWorker, isDebug, isQuitting, now = Date.now }) {
  const reportBusFailure = createFailureGate({ isDebug, isQuitting })
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
      await folderWatchers.startWatcher(
        args.shareId,
        args.mountPath,
        args.ignore || [],
        (event) => sendToWorker(worker, { type: 'event:owned-folder-fs-event', shareId: args.shareId, ...event }),
        // See the loose-file callback above: the storm message must reach the log ring on a
        // release build, or the report it explains is unreproducible.
        (err) => { console.warn('watcher error', args.shareId, '-', err.message) },
      )
    },

    [MAIN_REQUEST.OWNED_FOLDER_STOP_WATCHER]: async (args) => {
      folderWatchers.stopWatcher(args.shareId)
    },

    [MAIN_REQUEST.FOREIGN_FOLDER_START_WATCHER]: async (args, worker) => {
      await folderWatchers.startWatcher(
        mirrorWatchKey(args),
        args.mountPath,
        null,
        (event) => sendToWorker(worker, { type: 'event:foreign-folder-fs-event', spaceId: args.spaceId, shareId: args.shareId, ...event }),
        (err) => { console.warn('mirror watcher error', args.shareId, '-', err.message) },
      )
    },

    [MAIN_REQUEST.FOREIGN_FOLDER_STOP_WATCHER]: async (args) => {
      folderWatchers.stopWatcher(mirrorWatchKey(args))
    },
  })

  const warnUnknown = keyedWarner({ overflow: '[main-request] too many distinct unknown commands - no longer logging them', now })
  const warnFailure = keyedWarner({ overflow: '[main-request] too many distinct failures - no longer logging them', now })

  // The non-debug reports are warnings, for the same reason as the watcher storm warnings: these
  // lines are the only signal that a watcher was never armed.
  function reportUnknown(command) {
    const name = keyPart(command)
    reportBusFailure(null,
      () => ['[main-request] unknown command:', name, '- nothing was done'],
      () => warnUnknown(name, '[main-request] unknown command:', name, '- nothing was done'))
  }

  function reportFailure(command, err) {
    const code = keyPart(err?.code || err?.name || 'Error')
    reportBusFailure(err,
      (text) => ['[main-request] failed:', command, '-', text],
      (text) => warnFailure(command + ':' + code, '[main-request] failed:', command, '-', text, '- repeats with this code are not logged for a while'))
  }

  return {
    // The set main actually serves — read by the parity test, not by production code.
    commands: Object.freeze(Object.keys(handlers)),

    // Requests are one-way: the worker gets no reply, so a failure ends here and this never
    // rejects. Unknown and failed commands take the worker-bus failure policy
    // (worker-bus-failure.js), with a capped, rate-limited warning as the report outside debug.
    // Only a string is looked up: an object command whose toString is not callable throws there.
    async dispatch(command, args, worker) {
      const fn = typeof command === 'string' ? handlers[command] : undefined
      if (!fn) { reportUnknown(command); return }
      try {
        await fn(args, worker)
      } catch (err) {
        reportFailure(command, err)
      }
    },
  }
}

module.exports = { createMainRequestRouter }
