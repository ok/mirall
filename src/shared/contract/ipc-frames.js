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
// `hello` is here for the same reason and one more: it decides whether the rest of the wire is
// spoken at all, so it cannot be a row in a table the handshake has not yet authorised.
export const FRAME = Object.freeze({
  HELLO: 'hello',
  HELLO_ACK: 'hello-ack',
  BOOTSTRAP: 'bootstrap',
  RESPONSE: 'response',
  CANCEL: 'cancel',
})

/** @internal the cancellation guard's list */
export const CONTROL_FRAMES = Object.freeze(Object.values(FRAME))

// What a client says it is. Self-declared and therefore a claim, not a credential: it names the
// program on the other end so a log and a support bundle can say which one. A kind outside this
// tuple is refused rather than logged as a curiosity.
export const CLIENT_KINDS = Object.freeze(['electron-main', 'cli', 'mcp', 'test'])

// What a client may do, assigned by the worker from the transport it arrived on and never read off
// a frame — a claim is not a credential. Stopping the worker ends every client's session, so it is
// the host's call. Every site that assigns or tests a trust names it from here: the two spellings
// are one declaration, so a third cannot appear by being typed.
export const TRUST = Object.freeze({ HOST: 'host', PEER: 'peer' })

/** @typedef {(typeof CLIENT_KINDS)[number]} ClientKind */
/** @typedef {(typeof TRUST)[keyof typeof TRUST]} ClientTrust */

// The renderer/main↔worker wire contract's own version, deliberately NOT package.json's: a release
// that changes no frame must not invalidate a connection, and a frame change inside a patch release
// must. Bumped by hand, in the commit that changes the wire.
//
// MIN_SUPPORTED is the oldest peer this build still speaks to. Widening the window is a decision
// with a compatibility shim behind it; narrowing it is what a breaking change does.
export const IPC_PROTOCOL_VERSION = 2
export const IPC_PROTOCOL_MIN_SUPPORTED = 2
