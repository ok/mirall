import test from 'brittle'
import { readdirSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { SCENARIOS } from '../frontend/scenarios/index.mjs'

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../frontend/scenarios')

// run.mjs used to carry 134 import lines and a 135-key table beside a readdirSync of this same
// folder. Adding a scenario meant editing two spellings of one list, and forgetting the second
// meant the scenario silently never ran.
test('the index sees every scenario file', (t) => {
  const onDisk = readdirSync(DIR).filter((f) => /^s\d+-.*\.mjs$/.test(f)).length
  t.is(SCENARIOS.length, onDisk, `index has ${SCENARIOS.length}, disk has ${onDisk}`)
})

test('scenario keys are unique and run in numeric order', (t) => {
  const keys = SCENARIOS.map((s) => s.key)
  t.is(new Set(keys).size, keys.length, 'no duplicate sNN prefix')
  const nums = keys.map((k) => Number(k.slice(1)))
  t.alike(nums, [...nums].sort((a, b) => a - b), 's9 runs before s10')
})

// The registry is gone; a reintroduced one would drift from the directory again.
test('run.mjs holds no second copy of the list', (t) => {
  const src = readFileSync(path.join(DIR, '..', 'run.mjs'), 'utf8')
  t.absent(/^import s\d+ from/m.test(src), 'run.mjs imports scenarios through the index')
  t.absent(/const ALL = \{/.test(src), 'run.mjs has no scenario table')
})
