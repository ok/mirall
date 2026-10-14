// The space-wide storage summary behind the space view's storage widget: ONE
// {totalBytes, onDeviceBytes} across every folder share (owned, mirrored,
// browse-only) plus the loose files. Totals ride the existing count-only
// (limit=0) catalog drains, so a 150k-file share never materialises a row
// array here; on-device bytes are exact for owned content and derived from the
// verified-download registry for mirrors (the bulk form of the per-row listing
// predicate — no per-file disk stats).
import { createLogger } from '../core/logger.js'
import { getSpace } from '../spaces/space.js'
import { getLocalPublicKeyHex } from '../spaces/profile.js'
import { listSharesForSpace } from '../shares/share-registry.js'
import { isServableShare } from '../transfer/content-mode.js'
import { overlayBackend as backend } from '../transfer/overlay/index.js'
import { getForeignMount } from '../folders/mount-store.js'
import { listVerifiedForShare } from '../transfer/files.js'
import { listFiles } from '../transfer/file-listing.js'
import { isOnDeviceStatus } from '../contract/statuses.js'
import { markListIncomplete } from '../transfer/list-deficits.js'

const log = createLogger('space-storage')

const ZERO = { totalBytes: 0, onDeviceBytes: 0, complete: true }

// A stalled peer read counted part of the share: the contribution is a floor, and the space is
// flagged for the convergence tick to re-poke.
function peerContribution(spaceId, { totalBytes, stalled }, onDeviceBytes) {
  if (stalled) markListIncomplete(spaceId)
  return { totalBytes, onDeviceBytes, complete: !stalled }
}

async function shareContribution(spaceId, share, me) {
  if (!isServableShare(share)) return ZERO
  if (share.owner === me) {
    // An owned folder serves in place — its bytes are on this device by definition.
    const { totalBytes } = await backend.listOwn(spaceId, share.id, 0)
    return { totalBytes, onDeviceBytes: totalBytes, complete: true }
  }
  const mount = await getForeignMount(spaceId, share.id)
  if (!mount?.enabled) {
    // Browse-only: the share counts toward what the space holds, nothing is materialized.
    return peerContribution(spaceId, await backend.listPeerWithMeta(spaceId, share, { limit: 0 }), 0)
  }
  // Mirrored: a file counts on-device iff its verified-download record still matches
  // the owner's advertised hash, joined in bulk during the one count-only drain with no
  // per-file stat. A copy edited in place still counts, as its 'modified' row does; a copy
  // the user deleted from the mirror keeps counting only until the sync loop re-lands it.
  const verified = await listVerifiedForShare(spaceId, share.id)
  let onDeviceBytes = 0
  const read = await backend.listPeerWithMeta(spaceId, share, {
    limit: 0,
    onEach: (entry) => {
      if (entry.contentHash && verified.get(entry.relPath) === entry.contentHash && Number.isFinite(entry.size)) {
        onDeviceBytes += entry.size
      }
    },
  })
  return peerContribution(spaceId, read, onDeviceBytes)
}

export async function spaceStorageSummary(spaceId) {
  const space = await getSpace(spaceId)
  if (!space) return { ...ZERO }
  const me = getLocalPublicKeyHex()
  const shares = await listSharesForSpace(spaceId)
  // Per-share isolation: one unreadable/broken share degrades to zeros, and the summary to
  // incomplete, instead of blanking the whole widget. Reads run in parallel, each bounded like the
  // folder-info path (an offline owner yields its partial drain, not a hang).
  const contributions = await Promise.all(shares.map(async (share) => {
    try {
      return await shareContribution(spaceId, share, me)
    } catch (err) {
      log.warn('storage summary skipped share', share.id, '-', err.message)
      return { ...ZERO, complete: false }
    }
  }))
  let totalBytes = 0
  let onDeviceBytes = 0
  let complete = true
  for (const c of contributions) {
    totalBytes += c.totalBytes
    onDeviceBytes += c.onDeviceBytes
    complete &&= c.complete
  }
  // Loose files reuse the files:list source of truth verbatim, so the widget's
  // loose semantics (dedupe by hash, disk-reverified "downloaded") can't drift.
  const loose = await listFiles(spaceId, space.members || [], { space })
  totalBytes += loose.totalBytes
  for (const f of loose.entries) if (isOnDeviceStatus(f.status)) onDeviceBytes += f.size || 0
  return { totalBytes, onDeviceBytes, complete: complete && loose.complete }
}
