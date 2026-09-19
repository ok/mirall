// Frames that are NOT requests, on the IPC pipe between the renderer, main and the worker: they
// carry no handler, no args shape and no response. The handler table owns the request vocabulary
// (requests.js); this owns the rest of that wire. The frames peers exchange over the network are a
// separate vocabulary, contract/peer-frames.js.
//
// `shutdown` is deliberately absent: it looks like a control frame and is a real declared request,
// dispatched through the table like any other. A name may appear in exactly one of the two
// vocabularies, and a test asserts it.
//
// `cancel` is here rather than in REQUESTS deliberately: a cancel dispatched as a request would be
// queued behind the request it cancels during boot, which is precisely when it matters most.
export const FRAME = Object.freeze({
  BOOTSTRAP: 'bootstrap',
  RESPONSE: 'response',
  CANCEL: 'cancel',
})

/** @internal the cancellation guard's list */
export const CONTROL_FRAMES = Object.freeze(Object.values(FRAME))

// The renderer/main↔worker wire contract's own version, deliberately NOT package.json's: a release
// that changes no frame must not invalidate a connection, and a frame change inside a patch release
// must. Bumped by hand, in the commit that changes the wire.
//
// MIN_SUPPORTED is the oldest peer this build still speaks to. Widening the window is a decision
// with a compatibility shim behind it; narrowing it is what a breaking change does.
export const IPC_PROTOCOL_VERSION = 1
export const IPC_PROTOCOL_MIN_SUPPORTED = 1
