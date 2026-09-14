import test from 'brittle'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const DOC = '.claude/solution-architecture.md'

// §11 is the module table. A row that names a file that moved, or a file with no row, is how the
// table rotted to ~60 unlisted modules and a handful of ghosts (`friendlyTransferError`,
// `sign-windows-local.ps1`) before this guard existed. Both directions are cheap to check, so both are.
function sectionEleven() {
  const doc = readFileSync(path.join(root, DOC), 'utf8')
  const start = doc.indexOf('\n## 11. ')
  const end = doc.indexOf('\n## 12. ', start)
  if (start === -1 || end === -1) throw new Error(`${DOC}: could not find §11`)
  return doc.slice(start, end)
}

// Every backticked `src/...` token that names a file. Rows write full paths on purpose: a file → row
// grep is then unambiguous, and nothing has to infer a base directory from a heading.
function listedPaths(section) {
  const out = new Set()
  for (const m of section.matchAll(/`(src\/[^`\s]+\.(?:js|ts|tsx|cjs|mjs|json))`/g)) out.add(m[1])
  return out
}

// The renderer keeps directory-level rows (its files are named by folder), so only the data layer,
// main, preload and the worker are held to one-row-per-file.
const COVERED = ['src/shared', 'src/main', 'src/preload', 'src/worker']
const SKIP_DIRS = new Set(['vendor', 'locales'])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) { if (!SKIP_DIRS.has(name)) walk(p, out) }
    else if (/\.(js|ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push(path.relative(root, p))
  }
  return out
}

test('every file §11 names exists', (t) => {
  const listed = listedPaths(sectionEleven())
  t.ok(listed.size > 200, `§11 names ${listed.size} files`)
  const missing = [...listed].filter((p) => !existsSync(path.join(root, p))).sort()
  t.alike(missing, [], 'files named in §11 that do not exist')
})

test('every data-layer, main and worker module has a §11 row', (t) => {
  const listed = listedPaths(sectionEleven())
  const actual = COVERED.flatMap((d) => walk(path.join(root, d))).sort()
  t.ok(actual.length > 200, `walked ${actual.length} source files`)
  const unlisted = actual.filter((p) => !listed.has(p))
  t.alike(unlisted, [], 'source files with no §11 row')
})
