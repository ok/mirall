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
import { getContentBackend, UNSUPPORTED } from '../transfer/content-backends.js'
import { getForeignMount } from '../folders/mount-store.js'
import { listFiles, listVerifiedForShare } from '../transfer/files.js'

const log = createLogger('space-storage')

const ZERO = { totalBytes: 0, onDeviceBytes: 0 }

async function shareContribution(spaceId, share, me) {
  const backend = getContentBackend(share)
  if (backend === UNSUPPORTED) return ZERO
  if (share.owner === me) {
    // An owned folder serves in place — its bytes are on this device by definition.
    const { totalBytes } = await backend.listOwn(spaceId, share.id, 0)
    return { totalBytes, onDeviceBytes: totalBytes }
  }
  const mount = await getForeignMount(spaceId, share.id)
  if (!mount?.enabled) {
    // Browse-only: the share counts toward what the space holds, nothing is materialized.
    const { totalBytes } = await backend.listPeerWithMeta(spaceId, share, 0)
    return { totalBytes, onDeviceBytes: 0 }
  }
  // Mirrored: a file counts on-device iff its verified-download record still matches
  // the owner's advertised hash — the same predicate the per-row listing uses
  // (overlayConsumerRow), joined in bulk during the one count-only drain. A copy the
  // user deleted from the mirror keeps counting only until the sync loop re-lands it.
  const verified = await listVerifiedForShare(spaceId, share.id)
  let onDeviceBytes = 0
  const { totalBytes } = await backend.listPeerWithMeta(spaceId, share, 0, (entry) => {
    if (entry.contentHash && verified.get(entry.relPath) === entry.contentHash && Number.isFinite(entry.size)) {
      onDeviceBytes += entry.size
    }
  })
  return { totalBytes, onDeviceBytes }
}

export async function spaceStorageSummary(spaceId) {
  const space = await getSpace(spaceId)
  if (!space) return { ...ZERO }
  const me = getLocalPublicKeyHex()
  const shares = await listSharesForSpace(spaceId)
  // Per-share isolation: one unreadable/broken share degrades to zeros instead of
  // blanking the whole widget. Reads run in parallel, each bounded like the
  // folder-info path (an offline owner yields its partial drain, not a hang).
  const contributions = await Promise.all(shares.map(async (share) => {
    try {
      return await shareContribution(spaceId, share, me)
    } catch (err) {
      log.warn('storage summary skipped share', share.id, '-', err.message)
      return ZERO
    }
  }))
  let totalBytes = 0
  let onDeviceBytes = 0
  for (const c of contributions) {
    totalBytes += c.totalBytes
    onDeviceBytes += c.onDeviceBytes
  }
  // Loose files reuse the files:list source of truth verbatim, so the widget's
  // loose semantics (dedupe by hash, disk-reverified "downloaded") can't drift.
  for (const f of await listFiles(spaceId, space.members || [])) {
    totalBytes += f.size || 0
    if (f.status === 'mine' || f.status === 'downloaded') onDeviceBytes += f.size || 0
  }
  return { totalBytes, onDeviceBytes }
}
