// The `overlay` content-backend: the five-method contract over the HyperOverlayV2 instance and the
// per-share catalog. Lifecycle (init/attach/teardown) is the OverlayBackend subsystem's, not this
// object's; sweepPresence is the periodic backstop content-backends.js calls.
import * as A from './overlay-backend.js'

export const overlayBackend = {
  mode: 'overlay',
  publishAdd: A.overlayPublishAdd,
  publishDelete: A.overlayPublishDelete,
  listOwn: A.overlayListOwn,
  listPeerWithMeta: A.overlayListPeerWithMeta,
  // OPTIONAL member. A backend without it makes its mirrors walk every tick, which is the behaviour
  // before it existed. Optional deliberately: promoting a member of an injected contract to required
  // breaks every hand-written double at once, and such a break surfaces as a TypeError that kills
  // the test runner without printing an assertion — expensive to diagnose, trivial to avoid.
  catalogVersion: A.overlayCatalogVersion,
  requestDownload: A.overlayRequestDownload,
  sweepPresence: A.overlaySweepPresence,
}
