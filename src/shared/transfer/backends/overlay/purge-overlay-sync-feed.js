// One-time purge of the overlay's retired change feed: a local Hypercore named `sync-feed` that
// earlier builds appended to for every owned file on every boot and nothing read. The engine no
// longer opens it, so without this pass it would sit in the store for good, outside the leftover
// scan's wanted set and never reclaimed. Both overlay namespaces are covered: a store without a
// master secret still used the plaintext one. A failure leaves the marker unwritten and the pass
// retries at the next boot.
import { migrationResult, MIGRATION_STATUS } from '../../../storage/migrations/migration-result.js'
import { purgeNamedCore } from '../../../storage/core-purge.js'
import { OVERLAY_NAMESPACE, OVERLAY_NAMESPACE_ENC } from './overlay-namespaces.js'
import { runMarkedPass } from '../../../storage/migrations/marked-pass.js'
import { createLogger } from '../../../core/logger.js'

const log = createLogger('overlay-sync-feed-purge')

const FLAG = 'overlay-sync-feed-purge-v1'
export const SYNC_FEED_CORE = 'sync-feed'

export function purgeOverlaySyncFeed() {
  return runMarkedPass(FLAG, async (store) => {
    let purged = 0
    for (const name of [OVERLAY_NAMESPACE_ENC, OVERLAY_NAMESPACE]) {
      const ns = store.namespace(name)
      if (await store.storage.getAlias({ name: SYNC_FEED_CORE, namespace: ns.ns })) purged++
      await purgeNamedCore(store, ns, SYNC_FEED_CORE)
    }
    if (purged) log.info('purged the retired overlay change feed from', purged, 'namespace(s)')
    return { marker: { purged }, result: migrationResult(MIGRATION_STATUS.DONE, { compact: purged > 0, purged }) }
  }, log)
}
