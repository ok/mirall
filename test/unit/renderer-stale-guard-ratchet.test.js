import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { MAIN_QUERIES, MAIN_QUERY_NAMES } from '../../src/renderer/store/main-queries.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')

function walk (dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

// The four sites where the hand-rolled guard is DELIBERATE, each justified in a comment at the
// site:
//   AddFolderShareModal / MirrorFolderModal — point-in-time filesystem probes; a cached verdict
//     would answer for a path the user has since changed.
//   FilenameTitle — not a query at all; it guards a document.fonts.ready continuation.
//   useConnectionStatus — a single provider mounted once with an event feed; cache, dedup and
//     abort all buy nothing.
const ALLOWED = Object.freeze({
  'src/renderer/components/modals/AddFolderShareModal.tsx': 1,
  'src/renderer/components/modals/MirrorFolderModal.tsx': 1,
  'src/renderer/components/widgets/FilenameTitle.tsx': 1,
  'src/renderer/hooks/useConnectionStatus.tsx': 1,
})

function guardSites () {
  const found = {}
  for (const f of walk(path.join(root, 'src', 'renderer'))) {
    const hits = readFileSync(f, 'utf8').match(/let cancelled = false/g)
    if (hits) found[path.relative(root, f)] = hits.length
  }
  return found
}

// A ratchet, not a snapshot: the four below are decisions with reasons written at the site.
// Nothing may be ADDED without someone noticing, and removing one is a change to that file's
// reason, which belongs in its own commit together with this table.
test('REGRESSION (FIX-R04-2): the hand-rolled stale-response guard only shrinks', (t) => {
  const found = guardSites()

  const unexpected = Object.keys(found).filter((f) => !(f in ALLOWED))
  t.alike(unexpected, [], 'a new hand-rolled cancel flag was introduced — use useQuery/useMainQuery')

  for (const [file, cap] of Object.entries(ALLOWED)) {
    t.ok((found[file] ?? 0) <= cap, `${file} has at most ${cap} justified guard(s)`)
  }

  const total = Object.values(found).reduce((a, b) => a + b, 0)
  t.ok(total <= 4, `at most four justified guards remain (found ${total})`)
})

// The allowlist is only honest if each entry SAYS why. A file that keeps its flag without a reason
// is indistinguishable from one nobody got round to migrating.
test('every allowed guard carries its justification at the site', (t) => {
  for (const file of Object.keys(ALLOWED)) {
    const src = readFileSync(path.join(root, file), 'utf8')
    const idx = src.indexOf('let cancelled = false')
    t.ok(idx > 0, `${file} still has the guard the allowlist exempts`)
    const preamble = src.slice(Math.max(0, idx - 700), idx)
    t.ok(/\/\//.test(preamble), `${file} explains the guard in a comment above it`)
  }
})

// Symmetric to contract-requests.test.js's "every renderer request literal names a real request",
// for the main-process side of the renderer's read surface.
test('every main-query literal in the renderer names a declared fact', (t) => {
  const unknown = new Set()
  for (const f of walk(path.join(root, 'src', 'renderer'))) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/'(main:[a-z-]+)'/g)) {
      if (!MAIN_QUERIES[m[1]]) unknown.add(`${m[1]} (${path.relative(root, f)})`)
    }
  }
  t.alike([...unknown], [], 'the renderer reads a main fact that is not declared')
})

test('every declared main fact is well formed', (t) => {
  for (const name of MAIN_QUERY_NAMES) {
    const spec = MAIN_QUERIES[name]
    t.is(typeof spec.read, 'function', `${name} has a read`)
    t.is(typeof spec.write, 'function', `${name} has a write`)
    t.ok(spec.push === null || typeof spec.push === 'string', `${name} declares its push channel`)
  }
})
