// The app's one-shot install migrations as one ordered list, plus the runner that walks it.
//
// Each entry keeps its OWN durable marker and its own idempotence, deliberately — a runner that
// stamped a flag of its own on every non-throwing pass would break three of the four:
//   - local-bees-encrypt re-keys every local metadata bee, including the very bee a shared flag
//     table would have to live in, so its marker cannot live there. It is a file, on purpose.
//   - catalogs-encrypt closes its global marker only once EVERY space is done and deliberately
//     defers a space whose content key has not arrived yet, retrying it on later boots. A flag
//     written on a successful-but-deferred pass would strand that space's catalog in plaintext.
//   - overlay-index-encrypt reports whether it moved anything, which is what arms the caller's
//     post-migration compaction.
//
// What this list owns instead is ORDER and POSITION, which were previously carried only by where
// the composition root happened to call each one — so adding a migration that must precede another
// meant reading all four to find out. `stage` names the boot constraint each one really has:
//
//   durable     after the master secret is resolved and BEFORE any local bee is opened.
//   content     after the durable tier, before the initial publish scans and before the overlay
//               backend opens its index.
//   background  after the swarm is up, and never awaited — nothing here may block boot.
//
// `id` is this list's own name for a migration, not a durable key: the durable keys are the frozen
// markers inside each module and must never change.
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

// Runs one stage in list order and returns each migration's own result by id. Never throws: a
// migration that fails leaves its marker unwritten and retries at the next boot, which is the
// property every one of them already had individually and the one thing unifying them must not
// lose. A failure must not stop the stage either — that is what the per-migration guard the
// composition root used to write four times over is for.
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
