import test from 'brittle'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { pureNetworkModules } from '../../eslint-rules/invariants.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
// The modules are driven from test/unit; this guard lives in test/invariants, so the scan must name
// that directory rather than its own — scanning `here` would pass while nothing drove anything.
const unitDir = path.resolve(here, '../unit')
const networkDir = path.resolve(here, '../../src/shared/network')

// Listed as pure but not yet driven under Node. eslint still holds the no-bare-* line on them; what
// is missing is something proving the purity is load-bearing. The set may only shrink.
const UNDRIVEN = new Set([
  'content-peer-sockets', 'content-swarm', 'convergence-tick', 'deferred-admission',
  'leave-protocol', 'net-impair',
])

function unitSuite() {
  return readdirSync(unitDir)
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => readFileSync(path.join(unitDir, f), 'utf8'))
    .join('\n')
}

test('every pure network module exists', (t) => {
  for (const name of pureNetworkModules) {
    t.ok(existsSync(path.join(networkDir, `${name}.js`)), `src/shared/network/${name}.js exists`)
  }
})

test('every driven pure network module is imported by a unit test', (t) => {
  const suite = unitSuite()
  for (const name of pureNetworkModules) {
    if (UNDRIVEN.has(name)) continue
    t.ok(suite.includes(`shared/network/${name}.js`), `${name}.js is imported by a unit test`)
  }
})

test('RATCHET: the undriven set only shrinks', (t) => {
  const suite = unitSuite()
  const drivenNow = [...UNDRIVEN].filter((name) => suite.includes(`shared/network/${name}.js`))
  t.alike(drivenNow, [], 'these gained a unit test — remove them from UNDRIVEN')
  const stale = [...UNDRIVEN].filter((name) => !pureNetworkModules.includes(name))
  t.alike(stale, [], 'UNDRIVEN names a module that is no longer listed as pure')
})
