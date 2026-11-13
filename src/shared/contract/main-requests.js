// Every worker→main control frame. This bus does not go through the request table: main is not a
// handler-table peer, it is the host, and these commands ask it to do something only the host
// can do (hold the reveal roots, reach the worker's socket). Naming them here is what makes a
// rename mechanical instead of a silent half-rename — main's dispatch table is keyed off these
// constants and main-request-parity.test.js fails if the emitted set and the routed set differ.
// The event taxonomy guard cannot help: it matches on the `event:` prefix, and these have none.
export const MAIN_REQUEST_FRAME = 'main-request'

export const MAIN_REQUEST = Object.freeze({
  REVEAL_ROOTS: 'reveal:roots',
  SOCKET_LISTENING: 'socket:listening',
})

/** @internal the declaration-parity guard's list */
export const MAIN_REQUEST_NAMES = Object.freeze(Object.values(MAIN_REQUEST))
