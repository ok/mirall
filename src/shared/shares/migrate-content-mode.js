import { listSpaces } from '../spaces/space.js'
import { readOwnShares, publishShare } from './shares.js'
import { ownCatalogKeyHex } from './share-catalog.js'
import { createLogger } from '../core/logger.js'

const log = createLogger('share-migration')

// One-time, idempotent compat pass. Owned folder shares written by releases that predate
// the overlay backend carry contentMode undefined or the discontinued 'eager'/'deferred'
// modes — values that resolve to the UNSUPPORTED backend, under which the owner's own
// folder lists empty and stops publishing. Re-stamp
// each to overlay + a catalog key so it serves again; the normal initial publish scan (run
// right after this at boot) re-advertises the on-disk files into the catalog, and the
// updated share record replicates so peers' mirrors pick up the overlay backend.
export async function migrateLegacyOwnedSharesToOverlay () {
  let migrated = 0
  for (const space of await listSpaces()) {
    if (space.schemaVersion === 2) continue // v2 shares are re-stamped by migrateCatalogsToEncrypted
    const spaceId = space.spaceId
    let catalogKey = null
    for (const share of await readOwnShares(spaceId)) {
      if (share.contentMode === 'overlay') continue
      catalogKey ||= await ownCatalogKeyHex(spaceId)
      await publishShare(spaceId, { ...share, contentMode: 'overlay', catalogKey })
      migrated += 1
      log.info('migrated legacy share to overlay:', spaceId, share.id, '(was', share.contentMode ?? 'undefined', ')')
    }
  }
  if (migrated) log.info('re-stamped', migrated, 'legacy owned share(s) to overlay')
  return { migrated }
}
