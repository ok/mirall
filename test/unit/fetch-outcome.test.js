import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { FETCH_OUTCOME, DELIBERATE_STOPS } from '../../src/shared/transfer/backends/overlay/fetch-outcome.js'
import { classifyMiss } from '../../src/shared/transfer/backends/overlay/fetch-policy.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (p) => readFileSync(path.resolve(here, '../../src', p), 'utf8')

// Every module that settles a fetch diag. Source-scanned rather than imported: they pull in bare-*,
// which a Node runner cannot load — the same technique and rationale as fetch-policy-parity.test.js.
const EMITTERS = [
  'shared/transfer/backends/overlay/overlay-download.js',
  'shared/transfer/backends/overlay/fetch-run.js',
  'shared/folders/foreign-folders.js',
]

const VALUES = new Set(Object.values(FETCH_OUTCOME))

// REGRESSION (FIX-368: 'awaiting-republish' logged a false WARN "INCOMPLETE … gave up" on every
// republish park). The engine emitted an outcome the diag's set had never heard of, so finish()
// took its fail-safe caller-bug branch on a normal, documented flow. One vocabulary closes it: an
// outcome that is not a member is the bug this test is looking for.
test('REGRESSION: every outcome a producer emits is a member of FETCH_OUTCOME', (t) => {
  let emitted = 0
  for (const f of EMITTERS) {
    for (const call of read(f).matchAll(/\.finish\(([^)]*)\)/g)) {
      for (const lit of call[1].matchAll(/'([^']*)'/g)) {
        emitted++
        t.ok(VALUES.has(lit[1]), `${f} emits '${lit[1]}', a known outcome`)
      }
    }
  }
  t.ok(emitted > 0, 'the scan found the emitters (a silent zero would pass vacuously)')
})

// `FETCH_OUTCOME.TYPO` is `undefined`, which finish() would report as an unknown outcome at runtime
// rather than at build time — so the reference itself has to be checked.
test('every FETCH_OUTCOME reference names a real member', (t) => {
  let refs = 0
  for (const f of [...EMITTERS, 'shared/transfer/backends/overlay/overlay-backend.js', 'shared/transfer/backends/overlay/fetch-policy.js']) {
    for (const m of read(f).matchAll(/FETCH_OUTCOME\.([A-Z_]+)/g)) {
      refs++
      t.ok(m[1] in FETCH_OUTCOME, `${f} references FETCH_OUTCOME.${m[1]}`)
    }
  }
  t.ok(refs > 0, 'at least one producer reads the vocabulary')
})

// The WARN branch of finish() is `not done && not a deliberate stop`. A member that satisfies both
// halves is a false alarm in every user's log — which is exactly what 'awaiting-republish' was.
test('the WARN branch is unreachable for every outcome but a genuine give-up', (t) => {
  for (const outcome of VALUES) {
    const warns = outcome !== FETCH_OUTCOME.DONE && !DELIBERATE_STOPS.has(outcome)
    t.is(warns, outcome === FETCH_OUTCOME.FAILED, `finish('${outcome}') warns only if it is the give-up`)
  }
})

test('DELIBERATE_STOPS is derived from the vocabulary, not re-listed beside it', (t) => {
  t.alike(
    [...DELIBERATE_STOPS].sort(),
    [...VALUES].filter((o) => o !== FETCH_OUTCOME.DONE && o !== FETCH_OUTCOME.FAILED).sort(),
    'every non-terminal member is a deliberate stop',
  )
  t.ok(DELIBERATE_STOPS.has(FETCH_OUTCOME.AWAITING_REPUBLISH), 'a republish park is a deliberate stop')
})

test('the vocabulary is frozen', (t) => {
  t.ok(Object.isFrozen(FETCH_OUTCOME), 'no producer can extend it at runtime')
})

test('classifyMiss returns members of the vocabulary', (t) => {
  t.is(classifyMiss({ attempted: true }), FETCH_OUTCOME.FAILED)
  t.is(classifyMiss({ attempted: false }), FETCH_OUTCOME.NO_HOLDER)
})
