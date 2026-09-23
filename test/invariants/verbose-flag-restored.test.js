import test from 'brittle'
import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { Linter } from 'eslint'

const here = path.dirname(fileURLToPath(import.meta.url))
const testRoot = path.join(here, '..')
const SUITES = ['unit', 'invariants', 'integration', 'raw']

// The suites in these folders share one process, so they share the one module-level config object
// `verbose` lives in. Every flip therefore goes through test/helpers/runtime-verbose.js, which
// saves the config it found and restores it on teardown.
const HELPER = path.join(testRoot, 'helpers', 'runtime-verbose.js')
// The setter's own suite: its subject IS setRuntimeConfig, and it asserts on the config it leaves
// behind, so it cannot reach the value through a helper that hides the call.
const EXEMPT = new Set([path.join(testRoot, 'unit', 'runtime-config.test.js')])

const RESTRICTION = {
  selector: 'CallExpression[callee.name="setRuntimeConfig"] > ObjectExpression > Property[key.name="verbose"]',
  message: "set `verbose` through setVerbose(t, value) from test/helpers/runtime-verbose.js — a bare setRuntimeConfig leaves the flag on for every later suite in the process",
}

function suiteFiles() {
  const out = []
  for (const suite of SUITES) {
    const dir = path.join(testRoot, suite)
    for (const name of readdirSync(dir)) if (name.endsWith('.test.js')) out.push(path.join(dir, name))
  }
  return out
}

function verify(linter, file) {
  return linter.verify(readFileSync(file, 'utf8'), {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2025, sourceType: 'module' },
    rules: { 'no-restricted-syntax': ['error', RESTRICTION] },
  }, file)
}

// REGRESSION (FIX-478-1: the last test in ipc-failure-logging.test.js set verbose on and never put
// it back. Nothing there failed — the flag only changes what the logger prints — so the cost landed
// on ipc.test.js, which asserts the router is silent at the default level and saw the handshake
// line of a client it had greeted before turning verbose off. Red in the combined run CI executes,
// green in every single-file run either agent tried.)
test('REGRESSION (FIX-478-1): no shared-process suite flips verbose without restoring it', (t) => {
  const linter = new Linter()

  const caught = verify(linter, HELPER)
  t.is(caught.length, 1, 'the grammar matches the helper, which is the one place allowed to flip it')

  const offenders = []
  for (const file of suiteFiles()) {
    if (EXEMPT.has(file)) continue
    for (const m of verify(linter, file)) offenders.push(`${path.relative(testRoot, file)}:${m.line}`)
  }
  t.alike(offenders, [], 'every other suite reaches the flag through setVerbose(t, value)')
})
