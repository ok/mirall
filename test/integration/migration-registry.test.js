import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshDurable } from '../helpers/store.js'
import { MIGRATIONS, STAGES, runMigrations } from '../../src/shared/storage/migrations.js'

const srcRoot = path.join(path.dirname(import.meta.url.replace(/^file:\/\//, '')), '..', '..', 'src')

// FIRST in this file, and deliberately without a store: every migration opens one, so this is how a
// stage is driven into failure with the real list rather than an injected fake. The guard it proves
// is the one property unifying four separately-guarded migrations must not lose — a migration that
// fails leaves its own marker unwritten and retries at the next boot, and it must neither reject
// the boot nor stop the rest of its stage.
test('a migration that throws is reported, not propagated', async (t) => {
  const warnings = []
  const results = await runMigrations('background', { log: { warn: (...args) => warnings.push(args) } })
  t.is(results['legacy-peer-cache'], null, 'the failure is reported against its id')
  t.is(warnings.length, 1, 'and logged, so a permanently-failing migration is visible')
})

test('every migration has a unique id and a stage the runner knows', (t) => {
  const ids = MIGRATIONS.map((m) => m.id)
  t.is(new Set(ids).size, ids.length, 'no id is reused — a copy-pasted one would shadow another')
  for (const m of MIGRATIONS) {
    t.ok(STAGES.includes(m.stage), m.id + ' declares a known stage')
    t.is(typeof m.run, 'function', m.id + ' is runnable')
  }
})

// Ordering is the whole point of the list: it used to be carried only by where the composition root
// happened to call each migration, so adding one that must precede another meant reading them all.
test('the list is ordered by stage', (t) => {
  const positions = MIGRATIONS.map((m) => STAGES.indexOf(m.stage))
  t.alike(positions, [...positions].sort((a, b) => a - b), 'durable, then content, then background')
})

// The half that would catch a partly-done adoption: a migration silently left out of the list stops
// running on every install, and one still called directly from the root runs twice or out of order.
test('every migration the composition root used to call is in the list, and none is still called there', (t) => {
  const boot = fs.readFileSync(path.join(srcRoot, 'worker', 'boot.js'), 'utf8')
  const registry = fs.readFileSync(path.join(srcRoot, 'shared', 'storage', 'migrations.js'), 'utf8')
  const entryPoints = [
    'migrateLocalBeesToEncrypted',
    'migrateCatalogsToEncrypted',
    'migrateOverlayIndexToEncrypted',
    'reclaimLegacyPeerCaches',
  ]
  t.is(entryPoints.length, MIGRATIONS.length, 'the list covers exactly the migrations that exist')
  for (const name of entryPoints) {
    t.ok(registry.includes(name + '()'), name + ' is run from the list')
    t.absent(boot.includes(name + '('), name + ' is no longer called from the root directly')
  }
  for (const stage of STAGES) t.ok(boot.includes(`runMigrations('${stage}'`), 'the root runs the ' + stage + ' stage')
})

// The return value is load-bearing: it is what tells the caller the overlay index moved and the
// store is worth compacting.
test('the runner returns each migration its own result, keyed by id', async (t) => {
  await freshDurable(t)
  const results = await runMigrations('content', { log: { warn () {} } })
  t.alike(Object.keys(results).sort(), ['catalogs-encrypt', 'overlay-index-encrypt'],
    'only the content stage ran, and both of it did')
  t.is(typeof results['overlay-index-encrypt'], 'object', 'the overlay pass reports its own outcome')
})
