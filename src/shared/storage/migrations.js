// The app's one-shot install migrations as one ordered list, plus the runner that walks it. This
// list owns ORDER and STAGE only; each entry keeps its OWN durable marker and idempotence, because
// local-bees-encrypt re-keys the very bee a shared flag table would live in, catalogs-encrypt
// closes its marker only once EVERY space is done (a space whose content key has not arrived is
// deferred to a later boot), and overlay-index-encrypt reports whether it moved anything, which
// arms the caller's compaction. `stage` names the boot constraint:
//   durable     after the master secret is resolved and BEFORE any local bee is opened.
//   content     after the durable tier, before the initial publish scans and the overlay index.
//   background  after the swarm is up, and never awaited — nothing here may block boot.
// `id` is this list's own name, not a durable key: the durable keys are frozen inside each module.
import { migrateLocalBeesToEncrypted } from './metadata-migration.js'
import { reclaimLegacyPeerCaches } from './legacy-peer-cache.js'
import { migrateCatalogsToEncrypted } from '../shares/migrate-catalog-encrypt.js'
import { migrateOverlayIndexToEncrypted } from '../transfer/backends/overlay/migrate-overlay-index-encrypt.js'

export const STAGES = Object.freeze(['durable', 'content', 'background'])

export const MIGRATIONS = Object.freeze([
  { id: 'local-bees-encrypt', stage: 'durable', run: () => migrateLocalBeesToEncrypted() },
  { id: 'catalogs-encrypt', stage: 'content', run: () => migrateCatalogsToEncrypted() },
  { id: 'overlay-index-encrypt', stage: 'content', run: () => migrateOverlayIndexToEncrypted() },
  { id: 'legacy-peer-cache', stage: 'background', run: () => reclaimLegacyPeerCaches() },
])

// Runs one stage in list order and returns each migration's own result by id. Never throws, and a
// failure never stops the stage: a migration that fails leaves its marker unwritten and retries at
// the next boot.
export async function runMigrations(stage, { log } = {}) {
  const results = {}
  for (const migration of MIGRATIONS) {
    if (migration.stage !== stage) continue
    try {
      results[migration.id] = await migration.run()
    } catch (err) {
      results[migration.id] = null
      log?.warn('migration deferred to the next boot:', migration.id, '-', err.message)
    }
  }
  return results
}
