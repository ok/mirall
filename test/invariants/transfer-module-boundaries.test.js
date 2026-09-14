import test from 'brittle'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { pureTransferModules } from '../../eslint-rules/invariants.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
// The modules are driven from test/unit; this guard lives in test/invariants, so the scan must name
// that directory rather than its own — scanning `here` would pass while nothing drove anything.
const unitDir = path.resolve(here, '../unit')
const transferDir = path.resolve(here, '../../src/shared/transfer')

// Listed as pure but not yet driven under Node. eslint still holds the no-bare-* line on them, so
// the claim is enforced; what is missing is something that proves the purity is load-bearing. The
// set may only shrink — a module that gains a unit test leaves it and cannot come back.
const UNDRIVEN = new Set(['content-backends', 'pending-transfers', 'serve-ledger'])

function unitSuite() {
  return readdirSync(unitDir)
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => readFileSync(path.join(unitDir, f), 'utf8'))
    .join('\n')
}

test('every pure transfer module exists', (t) => {
  for (const name of pureTransferModules) {
    t.ok(existsSync(path.join(transferDir, `${name}.js`)), `src/shared/transfer/${name}.js exists`)
  }
})

test('every driven pure transfer module is imported by a unit test', (t) => {
  const suite = unitSuite()
  for (const name of pureTransferModules) {
    if (UNDRIVEN.has(name)) continue
    t.ok(suite.includes(`shared/transfer/${name}.js`), `${name}.js is imported by a unit test`)
  }
})

test('RATCHET: the undriven set only shrinks', (t) => {
  const suite = unitSuite()
  const drivenNow = [...UNDRIVEN].filter((name) => suite.includes(`shared/transfer/${name}.js`))
  t.alike(drivenNow, [], 'these gained a unit test — remove them from UNDRIVEN')

  const stale = [...UNDRIVEN].filter((name) => !pureTransferModules.includes(name))
  t.alike(stale, [], 'UNDRIVEN names a module that is no longer listed as pure')
})
