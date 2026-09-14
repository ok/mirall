// A leaf: imports nothing, so a migration can depend on the answer shape without depending on the
// list that runs it. Holding these in migrations.js made every migration cycle back to it.

// The boot constraint each MIGRATIONS entry declares, in the order the root runs them.
//   durable     after the master secret is resolved and BEFORE any local bee is opened.
//   content     after the durable tier, before the initial publish scans and the overlay index.
//   background  after the swarm is up, and never awaited — nothing here may block boot.
export const STAGES = Object.freeze(['durable', 'content', 'background'])

// What a migration did. `failed` is the runner's own answer for a throw; a migration reports the
// other three itself.
export const MIGRATION_STATUS = Object.freeze({
  DONE: 'done',
  SKIPPED: 'skipped',
  DEFERRED: 'deferred',
  FAILED: 'failed',
})

// The answer every migration returns. `detail` is whatever that migration counts; nothing outside it
// reads those fields, so they stay per-migration.
export function migrationResult(status, { compact = false, ...detail } = {}) {
  return { status, compact, ...detail }
}
