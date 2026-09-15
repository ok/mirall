import test from 'brittle'
import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { pureSharesModules } from '../../eslint-rules/invariants.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const unitDir = path.resolve(here, '../unit')
const sharesDir = path.resolve(here, '../../src/shared/shares')

const imports = (file) => [...readFileSync(path.join(sharesDir, file), 'utf8').matchAll(/^import[^']*'([^']+)'/gm)].map((m) => m[1])

test('no module in shares/ re-exports a sibling', (t) => {
  const offenders = []
  for (const file of readdirSync(sharesDir).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(path.join(sharesDir, file), 'utf8')
    for (const m of src.matchAll(/^export\s*\{[^}]*\}\s*from\s*'([^']+)'/gm)) offenders.push(`${file} → ${m[1]}`)
  }
  t.alike(offenders, [], 'callers name the module that owns the symbol')
})

// The owner's catalog and the read of everyone else's share a grammar and a fold, never each
// other: the moment one imports the other, the split is one file again with a longer path.
test('the own and peer catalog modules do not import each other', (t) => {
  t.absent(imports('own-catalog.js').includes('./peer-catalog.js'), 'own-catalog does not import peer-catalog')
  t.absent(imports('peer-catalog.js').includes('./own-catalog.js'), 'peer-catalog does not import own-catalog')
})

test('every pure shares module is driven by a unit test', (t) => {
  const suite = readdirSync(unitDir)
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => readFileSync(path.join(unitDir, f), 'utf8'))
    .join('\n')
  for (const name of pureSharesModules) {
    t.ok(suite.includes(`shared/shares/${name}.js`), `${name}.js is imported by a unit test`)
  }
})
