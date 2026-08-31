// The `overlay` content-backend: the 7-method contract over the HyperOverlayV2
// instance + per-share catalog, plus the optional lifecycle hooks (init/attach/
// teardown) the worker fans out to every backend. Only overlay implements them.
import * as A from './overlay-backend.js'
import { initOverlay, attachOverlay, teardownOverlay } from './overlay-instance.js'
import { createLogger } from '../../../core/logger.js'

const log = createLogger('overlay')

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
  ensureRemote: A.overlayEnsureRemote,
  releaseRemote: A.overlayReleaseRemote,

  // lifecycle: the OverlayBackend subsystem drives init/attach directly; teardown is still
  // fanned out by content-backends.js
  async init() {
    await initOverlay()
    // re-registering owned files walks every owned file and chunk-maps
    // it — don't block worker boot on it. Run in the background; the only cost is
    // a brief post-boot window where a just-rehydrated file isn't servable yet.
    A.rehydrateOwnedFiles().catch((err) => log.debug('overlay rehydrate failed:', err.message))
  },
  attach: attachOverlay,
  teardown: teardownOverlay,
  sweepPresence: A.overlaySweepPresence, // backstop, fanned out by sweepBackends
}
