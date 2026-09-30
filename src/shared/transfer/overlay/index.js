// A share's publish, list and download operations over the HyperOverlayV2 instance and the
// per-share catalog. Lifecycle (init/attach/teardown) is the OverlayBackend subsystem's, not this
// object's; sweepPresence is the periodic backstop worker/sweeps.js runs.
import { collectOwnShare } from '../../shares/own-catalog.js'
import { peerCatalogVersion } from '../../shares/peer-catalog.js'
import { folderPublishAdd, folderPublishDelete } from './folder-publish.js'
import { folderListPeerWithMeta, folderRequestDownload } from './folder-downloads.js'
import { sweepOwnedPresence } from './overlay-maintenance.js'

export const overlayBackend = {
  publishAdd: folderPublishAdd,
  publishDelete: folderPublishDelete,
  // One tolerant pass returns the capped rows AND the true {total, totalBytes} (folder-info passes
  // limit=0 to count only). A corrupt catalog core degrades to a partial result instead of blanking
  // the share; mutating callers keep listOwnShare and fail loud.
  listOwn: collectOwnShare,
  listPeerWithMeta: folderListPeerWithMeta,
  // A cheap head probe, so a mirror tick skips the full walk when the owner's catalog is unchanged.
  catalogVersion: peerCatalogVersion,
  requestDownload: folderRequestDownload,
  sweepPresence: sweepOwnedPresence,
}
