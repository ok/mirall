// The app's one-shot install migrations as one ordered list, plus the runner that walks it.
//
// Every entry answers in the same shape — { status, compact } — so the caller reads one thing
// rather than a different truthiness test per migration. `compact` is the migration saying it moved
// bytes and the store should be compacted; the caller decides when, because compaction contends
// with boot I/O.
//
// Each entry still owns its own durable MARKER, and that part cannot be shared:
// local-bees-encrypt re-keys the very bee a shared flag table would live in, so its marker is a
// file on disk, and catalogs-encrypt needs a per-space marker as well as a global one because a
// space whose content key has not arrived yet is deferred to a later boot. `stage` names the boot
// constraint — see STAGES in migration-result.js.
// `id` is this list's own name, not a durable key: the durable keys are frozen inside each module.
import { migrateLocalBeesToEncrypted } from './metadata-migration.js'
import { retireSpaceDrives } from './retire-space-drives.js'
import { migrateCatalogsToEncrypted } from '../../shares/migrate-catalog-encrypt.js'
import { migrateOverlayIndexToEncrypted } from '../../transfer/backends/overlay/migrate-overlay-index-encrypt.js'
import { MIGRATION_STATUS, migrationResult } from './migration-result.js'

/** @internal */
export const MIGRATIONS = Object.freeze([
  { id: 'local-bees-encrypt', stage: 'durable', run: () => migrateLocalBeesToEncrypted() },
  { id: 'catalogs-encrypt', stage: 'content', run: () => migrateCatalogsToEncrypted() },
  { id: 'overlay-index-encrypt', stage: 'content', run: () => migrateOverlayIndexToEncrypted() },
  { id: 'retire-space-drives', stage: 'background', run: () => retireSpaceDrives() },
])

// Runs one stage in list order and returns each migration's result by id. Never throws, and a
// failure never stops the stage: a migration that fails leaves its marker unwritten and retries at
// the next boot.
//
// `stageCompacted` answers the only question every caller asked of these results by hand.
export async function runMigrations(stage, { log } = {}) {
  const results = {}
  for (const migration of MIGRATIONS) {
    if (migration.stage !== stage) continue
    try {
      results[migration.id] = await migration.run()
    } catch (err) {
      results[migration.id] = migrationResult(MIGRATION_STATUS.FAILED)
      log?.warn('migration deferred to the next boot:', migration.id, '-', err.message)
    }
  }
  return results
}

// True when any migration in this stage's results moved bytes. The caller compacts once for the
// stage rather than once per migration, and it decides when.
export function stageCompacted(results) {
  return Object.values(results).some((r) => r?.compact === true)
}
