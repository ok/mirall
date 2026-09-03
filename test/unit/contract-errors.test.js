import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { CODES, CODE_NAMES, UNUSED_CODES, EXPECTED_CODES } from '../../src/shared/contract/errors.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')

function walk (dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'vendor') walk(p, out) }
    else if (/\.js$/.test(name)) out.push(p)
  }
  return out
}

// Comments are stripped first: a doc comment naming `ErrorCodes.X` is prose, not a throw site, and
// counting it would make this test fail on its own explanation.
function stripComments (src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

// Both the enum form and the bare-string form, because the bug this guards was a code thrown as a
// string that no enum member matched.
function thrownCodes () {
  const found = new Set()
  for (const f of [...walk(path.join(root, 'src', 'shared')), ...walk(path.join(root, 'src', 'worker'))]) {
    const src = stripComments(readFileSync(f, 'utf8'))
    for (const m of src.matchAll(/ErrorCodes\.([A-Z_]+)/g)) found.add(m[1])
    for (const m of src.matchAll(/\.code = '([A-Z_]+)'/g)) found.add(m[1])
    for (const m of src.matchAll(/code: '([A-Z_]+)'/g)) found.add(m[1])
  }
  return found
}

// REGRESSION (FIX-CONTRACT-CODES: space:join throws INVITE_INVALID while ErrorCodes declared
// INVALID_INVITE. Nothing mapped the thrown spelling, so JoinSpaceModal showed raw English.)
test('REGRESSION (FIX-CONTRACT-CODES): every code the worker can throw is declared', (t) => {
  const undeclared = [...thrownCodes()].filter((c) => !CODES[c]).sort()
  t.alike(undeclared, [], 'codes thrown but absent from the contract')
})

test('the unused list is honest and only shrinks', (t) => {
  const thrown = thrownCodes()
  const stillThrown = UNUSED_CODES.filter((c) => thrown.has(c))
  t.alike(stillThrown, [], 'a code listed as unused is actually thrown — move it out of the list')
  for (const c of UNUSED_CODES) t.ok(CODES[c], `${c} is declared`)
  t.ok(UNUSED_CODES.length <= 11, 'no code was added to the unused list')
})

test('the renderer maps every code a user can see', (t) => {
  const src = readFileSync(path.join(root, 'src', 'renderer', 'errorMessages.js'), 'utf8')
  const mapped = new Set([...src.matchAll(/^\s*([A-Z_]+):/gm)].map((m) => m[1]))
  const internal = new Set([...UNUSED_CODES, ...EXPECTED_CODES])
  const unmapped = CODE_NAMES.filter((c) => !mapped.has(c) && !internal.has(c))
  // Not asserted empty: mapping the rest is a copy change across five locale files, which is its
  // own piece of work. Pinned as a ratchet so the gap cannot GROW now that the contract makes it
  // countable — INVITE_INVALID, INVITE_EXPIRED and LEAVE_IN_PROGRESS are in here, and they are why
  // JoinSpaceModal still shows raw English.
  t.ok(unmapped.length <= 17, `unmapped user-visible codes: ${unmapped.length} (ratchet: 17)`)
})

test('expected codes are declared and are genuinely thrown', (t) => {
  const thrown = thrownCodes()
  for (const c of EXPECTED_CODES) {
    t.ok(CODES[c], `${c} is declared`)
    t.ok(thrown.has(c), `${c} is actually thrown — a stale entry would silence a real failure`)
  }
})
