import test from 'brittle'
import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { until, waitFor } from '../helpers/poll.js'

const testRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCANNED = ['unit', 'invariants', 'integration', 'flow', 'raw', 'helpers']

// The loop, not the name: the eighteen copies this replaced went under five different names, so a
// name list would have missed the next one. A deadline computed from Date.now() and then polled is
// the shape.
const DEADLINE_LOOP = /const deadline = Date\.now\(\)|while \([^)]*Date\.now\(\)/

// poll.js and bare-poll.js are where the loop belongs.
//
// The rest are not polls and must not be folded into one:
//   _holepunch.js `eventually` returns the awaited VALUE, treating null/undefined/false as "not
//   yet"; six call sites read that value.
//   The samplers accumulate across iterations — a peak, a monotonic flag, the set of statuses seen
//   before a row went remote, or whether a forbidden status ever appeared inside a window. Their
//   assertion is about the HISTORY, not the end state, so a helper that returns on first match
//   would delete the thing they measure.
const OWNERS = new Set([
  path.join('helpers', 'poll.js'),
  path.join('helpers', 'bare-poll.js'),
  path.join('raw', '_holepunch.js'),
  path.join('flow', 'folder-listing-monotonic.test.js'),
  path.join('flow', 'loose-crash-mid-index.test.js'),
  path.join('flow', 'loose-preparing-status.test.js'),
  path.join('flow', 'mirror-offline-delete-restore.test.js'),
  path.join('flow', 'mirror-offline-idle.test.js'),
  path.join('flow', 'owned-add-during-index.test.js'),
])

function scannedFiles() {
  const out = []
  for (const dir of SCANNED) {
    for (const name of readdirSync(path.join(testRoot, dir))) {
      if (/\.(js|mjs)$/.test(name)) out.push(path.join(dir, name))
    }
  }
  return out
}

test('REGRESSION: nothing rebuilds the poll loop', (t) => {
  const offenders = scannedFiles()
    .filter((rel) => !OWNERS.has(rel))
    .filter((rel) => DEADLINE_LOOP.test(readFileSync(path.join(testRoot, rel), 'utf8')))
  t.alike(offenders.sort(), [], 'poll helpers come from test/helpers/{poll,bare-poll}.js')
})

test('until reports a timeout; waitFor throws it', async (t) => {
  t.is(await until(() => false, 60, { interval: 10, scale: false }), false)
  t.is(await until(() => true, 60, { interval: 10, scale: false }), true)
  await t.exception(() => waitFor(() => false, 60, { interval: 10, scale: false, label: 'nothing' }), /nothing/)
})

// The extra check the three re-checking call sites relied on: a condition that only becomes true
// during the final sleep still has to be seen.
test('a condition that flips during the last sleep is still seen', async (t) => {
  let ready = false
  setTimeout(() => { ready = true }, 45)
  t.is(await until(() => ready, 40, { interval: 30, scale: false }), true)
})

test('a sync predicate is accepted', async (t) => {
  t.is(await until(() => 1 === 1, 60, { interval: 10, scale: false }), true)
})
