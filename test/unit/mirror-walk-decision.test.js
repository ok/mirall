import test from 'brittle'
import { shouldWalk, DEFAULT_FULL_WALK_EVERY } from '../../src/shared/folders/mirror-walk.js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

test('a mirror with no watermark always walks', (t) => {
  t.is(shouldWalk({ watermark: null, version: 7 }).walk, true)
  t.is(shouldWalk({ watermark: null, version: 7 }).reason, 'no-watermark')
  t.is(shouldWalk().walk, true, 'and so does a call with nothing known at all')
})

// The fail-safe direction: a probe that cannot answer must cost work, never authorise a skip.
test('an unknown version always walks, even against a matching watermark', (t) => {
  t.is(shouldWalk({ watermark: 7, version: null }).walk, true)
  t.is(shouldWalk({ watermark: 7, version: null }).reason, 'version-unknown')
  t.is(shouldWalk({ watermark: null, version: null }).walk, true)
})

test('a moved head walks; an unchanged head skips', (t) => {
  t.is(shouldWalk({ watermark: 7, version: 8 }).reason, 'catalog-appended')
  t.is(shouldWalk({ watermark: 8, version: 7 }).reason, 'catalog-appended',
    'a version that went BACKWARDS is still a change, never a skip')
  const skip = shouldWalk({ watermark: 7, version: 7 })
  t.is(skip.walk, false, 'the whole point of the change')
  t.is(skip.reason, null)
})

test('version 0 and version 1 are distinguished from unknown', (t) => {
  // A brand-new catalog reads version 1, and 0 is falsy — neither may collapse into "unknown".
  t.is(shouldWalk({ watermark: 1, version: 1 }).walk, false, 'a fresh catalog can converge')
  t.is(shouldWalk({ watermark: 0, version: 0 }).walk, false)
  t.is(shouldWalk({ watermark: 0, version: 1 }).reason, 'catalog-appended')
})

test('the backstop forces a walk on the Nth consecutive tick', (t) => {
  const at = (skipped) => shouldWalk({ watermark: 7, version: 7, skipped, fullWalkEvery: 10 })
  for (let s = 0; s < 9; s++) t.is(at(s).walk, false, `skip ${s + 1} of 9 is still a skip`)
  t.is(at(9).walk, true, 'the 10th tick walks')
  t.is(at(9).reason, 'backstop')
  t.is(at(99).walk, true, 'and anything past it keeps walking until the counter resets')
})

// The rollback contract: one config value restores today's behaviour exactly.
test('foreignFullWalkEvery of 1 or less disables the skip entirely', (t) => {
  for (const every of [1, 0, -1]) {
    const d = shouldWalk({ watermark: 7, version: 7, skipped: 0, fullWalkEvery: every })
    t.is(d.walk, true, `fullWalkEvery ${every} always walks`)
    t.is(d.reason, 'backstop-disabled')
  }
})

test('the default is the 10-tick backstop', (t) => {
  t.is(DEFAULT_FULL_WALK_EVERY, 10)
  t.is(shouldWalk({ watermark: 7, version: 7, skipped: 8 }).walk, false)
  t.is(shouldWalk({ watermark: 7, version: 7, skipped: 9 }).walk, true)
})

// The default is declared twice across a layer boundary — core/ must not import from folders/, the
// same constraint that makes PUBLISH_ORDERS a hand-kept twin with its own parity assertion. Without
// this, changing one leaves the other stale and nothing fails: production always reads the
// runtime-config value, so the module default is only ever exercised here.
test('DEFAULT_FULL_WALK_EVERY matches the runtime-config default', (t) => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(path.join(here, '..', '..', 'src', 'shared', 'core', 'runtime-config.js'), 'utf8')
  const m = src.match(/^\s*foreignFullWalkEvery:\s*(\d+),/m)
  t.ok(m, 'runtime-config declares foreignFullWalkEvery')
  t.is(Number(m[1]), DEFAULT_FULL_WALK_EVERY, 'the two declarations agree')
})
