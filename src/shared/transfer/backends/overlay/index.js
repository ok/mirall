// The `overlay` content-backend: the five-method contract over the HyperOverlayV2 instance and the
// per-share catalog. Lifecycle (init/attach/teardown) is the OverlayBackend subsystem's, not this
// object's; sweepPresence is the periodic backstop content-backends.js calls.
import { collectOwnShare } from '../../../shares/own-catalog.js'
import { peerCatalogVersion } from '../../../shares/peer-catalog.js'
import { folderPublishAdd, folderPublishDelete } from './folder-publish.js'
import { folderListPeerWithMeta, folderRequestDownload } from './folder-downloads.js'
import { sweepOwnedPresence } from './overlay-maintenance.js'

export const overlayBackend = {
  mode: 'overlay',
  publishAdd: folderPublishAdd,
  publishDelete: folderPublishDelete,
  // One tolerant pass returns the capped rows AND the true {total, totalBytes} (folder-info passes
  // limit=0 to count only). A corrupt catalog core degrades to a partial result instead of blanking
  // the share; mutating callers keep listOwnShare and fail loud.
  listOwn: collectOwnShare,
  listPeerWithMeta: folderListPeerWithMeta,
  // OPTIONAL member. A backend without it makes its mirrors walk every tick, which is the behaviour
  // before it existed. Optional deliberately: promoting a member of an injected contract to required
  // breaks every hand-written double at once, and such a break surfaces as a TypeError that kills
  // the test runner without printing an assertion — expensive to diagnose, trivial to avoid.
  catalogVersion: peerCatalogVersion,
  requestDownload: folderRequestDownload,
  sweepPresence: sweepOwnedPresence,
}
