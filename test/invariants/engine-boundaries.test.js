import test from 'brittle'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { ENGINE_DIR, pureEngineModules } from '../../eslint-rules/invariants.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ENGINE = path.join(root, ENGINE_DIR)
const WRAPPER = 'src/shared/transfer/backends/overlay'

// App code enters the engine only through these modules, and only from these files. A new importer
// or a new entry is a decision that takes a row here; a re-export hub would hide the graph instead.
const ENTRIES = new Map([
  ['overlay-v2.js', [`${WRAPPER}/overlay-instance.js`]],
  ['content-path.js', [`${WRAPPER}/overlay-instance.js`]],
  ['chunker.js', [`${WRAPPER}/overlay-hash.js`, 'scripts/bench-prepare.mjs']],
  ['store/file-index.js', [`${WRAPPER}/migrate-overlay-index-encrypt.js`, 'scripts/bench-prepare.mjs']],
  ['transfer/journal.js', [`${WRAPPER}/overlay-journals.js`]],
  ['transfer/prepare.js', ['scripts/bench-prepare.mjs']],
])

// Listed as pure but not yet driven under Node. eslint holds the no-bare-* line on them; what is
// missing is a unit test proving the purity is load-bearing. The set may only shrink.
const UNDRIVEN = new Set(['protocol/channel', 'protocol/serve-fds', 'store/paged-values'])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'node_modules') walk(p, out) } else if (/\.(js|mjs)$/.test(name)) out.push(p)
  }
  return out
}

function engineImports() {
  const found = []
  for (const file of [...walk(path.join(root, 'src')), ...walk(path.join(root, 'scripts'))]) {
    if (file.startsWith(ENGINE + path.sep)) continue
    for (const m of readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) {
      if (!m[1].startsWith('.')) continue
      const target = path.resolve(path.dirname(file), m[1])
      if (target.startsWith(ENGINE + path.sep)) found.push({ importer: path.relative(root, file), entry: path.relative(ENGINE, target) })
    }
  }
  return found
}

test('app code enters the engine only through an allowlisted module and importer', (t) => {
  const found = engineImports()
  t.ok(found.length >= 6, 'the scan found the known importers')
  const stray = found.filter(({ importer, entry }) => !ENTRIES.get(entry)?.includes(importer))
  t.alike(stray.map(({ importer, entry }) => `${importer} → ${entry}`), [], 'imports outside the allowlist')
  const unused = [...ENTRIES].flatMap(([entry, importers]) => importers.filter((i) => !found.some((f) => f.entry === entry && f.importer === i)).map((i) => `${i} → ${entry}`))
  t.alike(unused, [], 'allowlisted edges that no longer exist')
})

test('the engine names no app path scheme', (t) => {
  const hits = walk(ENGINE).filter((f) => readFileSync(f, 'utf8').includes('/mir/'))
  t.alike(hits.map((f) => path.relative(root, f)), [])
})

function unitSuite() {
  const dir = path.join(root, 'test', 'unit')
  return readdirSync(dir).filter((f) => f.endsWith('.test.js')).map((f) => readFileSync(path.join(dir, f), 'utf8')).join('\n')
}

test('every pure engine module exists and every driven one is imported by a unit test', (t) => {
  const suite = unitSuite()
  for (const name of pureEngineModules) {
    t.ok(existsSync(path.join(ENGINE, `${name}.js`)), `${name}.js exists`)
    if (!UNDRIVEN.has(name)) t.ok(suite.includes(`overlay/engine/${name}.js`), `${name}.js is imported by a unit test`)
  }
})

test('RATCHET: the undriven set only shrinks', (t) => {
  const suite = unitSuite()
  t.alike([...UNDRIVEN].filter((name) => suite.includes(`overlay/engine/${name}.js`)), [], 'these gained a unit test — remove them from UNDRIVEN')
  t.alike([...UNDRIVEN].filter((name) => !pureEngineModules.includes(name)), [], 'UNDRIVEN names a module that is no longer listed as pure')
})
