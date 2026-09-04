// Every worker→main control frame. This bus does not go through the request table: main is not a
// handler-table peer, it is the host, and these five commands ask it to do something only the host
// can do (own the chokidar watchers, hold the download roots). Naming them here is what makes a
// rename mechanical instead of a silent half-rename — main's dispatch table is keyed off these
// constants and main-request-parity.test.js fails if the emitted set and the routed set differ.
// The event taxonomy guard cannot help: it matches on the `event:` prefix, and these have none.
export const MAIN_REQUEST_FRAME = 'main-request'

export const MAIN_REQUEST = Object.freeze({
  DOWNLOADS_ROOTS: 'downloads:roots',
  LOOSE_FILE_WATCH: 'loose-file:watch',
  LOOSE_FILE_UNWATCH: 'loose-file:unwatch',
  OWNED_FOLDER_START_WATCHER: 'owned-folder:start-watcher',
  OWNED_FOLDER_STOP_WATCHER: 'owned-folder:stop-watcher',
})

export const MAIN_REQUEST_NAMES = Object.freeze(Object.values(MAIN_REQUEST))
