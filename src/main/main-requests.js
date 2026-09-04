'use strict'

const path = require('node:path')
const { MAIN_REQUEST } = require('../shared/contract/main-requests.js')

// The worker→main control bus. Keyed off the contract constants rather than string literals, so a
// rename that touches only one process cannot pass main-request-parity.test.js.
//
// The `else` matters as much as the table. Five `if (command === …) return` blocks with nothing
// after them meant an unrecognised command was indistinguishable from a handled one: the promise
// resolved, the caller's .catch never fired, and every owned folder simply stopped re-publishing.
function createMainRequestRouter ({ ownedFolderWatchers, looseFileWatchers, setDownloadRoots, sendToWorker, onUnknown }) {
  const handlers = {
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
      ownedFolderWatchers.startWatcher(
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
  }

  return {
    // The set main actually serves — read by the parity test, not by production code.
    commands: Object.freeze(Object.keys(handlers)),

    async handle (command, args, worker) {
      const fn = handlers[command]
      if (!fn) {
        onUnknown?.(command)
        // Not behind `debug`, for the same reason as the watcher storm warnings: this line is the
        // only signal that a watcher was never armed.
        console.warn('[main-request] unknown command:', command, '- nothing was done')
        return
      }
      await fn(args, worker)
    },
  }
}

module.exports = { createMainRequestRouter }
