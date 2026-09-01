import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const roots = ['shared', 'worker', 'main', 'preload'].map((d) => path.join(here, '..', '..', 'src', d))

function walk (dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'vendor') walk(p, out) } else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

// The names a module actually provides. `export *` is a wildcard we cannot resolve without
// following the chain, so a module carrying one opts out rather than reporting false misses.
export function exportedNames (source) {
  const names = new Set()
  for (const m of source.matchAll(/(?:^|\n)export\s+(?:async\s+)?function\s*\*?\s*(\w+)/g)) names.add(m[1])
  for (const m of source.matchAll(/(?:^|\n)export\s+(?:const|let|var|class)\s+(\w+)/g)) names.add(m[1])
  for (const m of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const p = part.trim()
      if (p) names.add(p.split(/\s+as\s+/).pop().trim())
    }
  }
  if (/(?:^|\n)export\s+default/.test(source)) names.add('default')
  if (/(?:^|\n)export\s*\*/.test(source)) names.add('*')
  return names
}

// Named imports from a relative specifier, which are the only ones we can resolve on disk.
export function relativeNamedImports (source) {
  const out = []
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(\.[^']+)'/g)) {
    const names = m[1].split(',').map((p) => p.trim()).filter(Boolean)
      .map((p) => p.split(/\s+as\s+/)[0].trim())
    out.push({ spec: m[2], names })
  }
  return out
}

// REGRESSION (SWARM-DECOMP-2: a name moved out of swarm.js while an importer still asked swarm.js
// for it. no-undef cannot see this — the identifier IS bound in the importer, to an import that
// resolves to nothing — and neither typecheck nor the unit suite loads the data layer, so it
// surfaced only as `does not provide an export named 'broadcastPresence'` when the Bare loader
// refused the worker bundle, minutes into a flow run. Twice.)
test('REGRESSION (SWARM-DECOMP-2): every named import resolves to a real export', (t) => {
  // The grammar, on fixtures: what must be caught, and what must stay legal.
  t.ok(exportedNames('export async function* listOwnShare (a) {}\n').has('listOwnShare'),
    'an async generator counts as exported')
  t.ok(exportedNames("export { a as b } from './x.js'\n").has('b'), 'a re-export under a new name counts')
  t.ok(exportedNames('export const x = 1\nexport let y = 2\n').has('y'), 'a mutable binding counts')
  t.absent(exportedNames('const notExported = 1\n').has('notExported'), 'a plain declaration does not')
  t.ok(exportedNames("export * from './x.js'\n").has('*'), 'a wildcard is reported so callers can opt out')
  t.alike(relativeNamedImports("import { a, b as c } from './m.js'\n"), [{ spec: './m.js', names: ['a', 'b'] }],
    'named imports are read under their source name')
  t.alike(relativeNamedImports("import x from 'hyperswarm'\n"), [], 'bare specifiers are out of scope')

  const cache = new Map()
  const missing = []
  for (const root of roots) {
    for (const file of walk(root)) {
      const source = readFileSync(file, 'utf8')
      for (const { spec, names } of relativeNamedImports(source)) {
        const target = path.resolve(path.dirname(file), spec)
        if (!cache.has(target)) {
          let provided = null
          try { provided = exportedNames(readFileSync(target, 'utf8')) } catch { provided = null }
          cache.set(target, provided)
        }
        const provided = cache.get(target)
        if (!provided || provided.has('*')) continue
        for (const name of names) {
          if (!provided.has(name)) missing.push(`${path.relative(here, file)} imports "${name}" from ${spec}`)
        }
      }
    }
  }
  t.alike(missing, [], 'no module asks a sibling for a name it does not export')
})
