// Frames that are NOT requests: they carry no handler, no args shape and no response. The handler
// table owns the request vocabulary (requests.js); this owns the rest of the wire.
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

export const CONTROL_FRAMES = Object.freeze(Object.values(FRAME))
