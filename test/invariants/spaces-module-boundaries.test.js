import test from 'brittle'
import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { pureSpacesModules } from '../../eslint-rules/invariants.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
// The modules are driven from test/unit; this guard lives in test/invariants, so the scan must name
// that directory rather than its own — scanning `here` would pass while nothing drove anything.
const unitDir = path.resolve(here, '../unit')
const spacesDir = path.resolve(here, '../../src/shared/spaces')

// profile.js hands out four peer-bee reads under its own name because three other modules already
// reach a peer's profile through it. That one is deliberate and documented at the export; every
// other re-export in the folder is a decomposition being undone one import at a time, which
// nothing else fails on.
const ALLOWED_REEXPORTS = new Map([['profile.js', './peer-bee.js']])

test('no module in spaces/ re-exports a sibling it does not own', (t) => {
  const offenders = []
  for (const file of readdirSync(spacesDir).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(path.join(spacesDir, file), 'utf8')
    for (const m of src.matchAll(/^export\s*\{[^}]*\}\s*from\s*'([^']+)'/gm)) {
      if (ALLOWED_REEXPORTS.get(file) === m[1]) continue
      offenders.push(`${file} → ${m[1]}`)
    }
  }
  t.alike(offenders, [], 'callers name the module that owns the symbol')
})

// The record store is a leaf: it reads and writes the spaces-meta bee and nothing else. The moment
// it reaches back up into a module that reads it, the folder has an import cycle again — which is
// the shape that kept share-catalog and space.js tangled.
test('the space record store imports no module that reads it', (t) => {
  const src = readFileSync(path.join(spacesDir, 'space.js'), 'utf8')
  const imported = [...src.matchAll(/^import[^']*'([^']+)'/gm)].map((m) => m[1])
  for (const bad of ['../shares/share-catalog.js', './space-drives.js', './space-lifecycle.js', './leave-records.js', './creator-pin.js']) {
    t.absent(imported.includes(bad), `space.js does not import ${bad}`)
  }
})

// eslint.config.mjs is the one statement that these modules are pure; the half the linter cannot see
// is that something actually loads them under Node. A listed module with no unit importer is a
// purity claim nobody exercises.
test('every pure spaces module is driven by a unit test', (t) => {
  const suite = readdirSync(unitDir)
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => readFileSync(path.join(unitDir, f), 'utf8'))
    .join('\n')
  for (const name of pureSpacesModules) {
    t.ok(suite.includes(`shared/spaces/${name}.js`), `${name}.js is imported by a unit test`)
  }
})
