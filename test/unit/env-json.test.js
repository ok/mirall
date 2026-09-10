import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { envJson } from '../../src/main/env-json.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const mainSrc = readFileSync(path.join(here, '..', '..', 'src', 'main', 'main.js'), 'utf8')

function captureWarnings (fn) {
  const warnings = []
  const orig = console.warn
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')) }
  try { return { result: fn(), warnings } } finally { console.warn = orig }
}

function withEnv (t, name, value) {
  const prev = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  t.teardown(() => {
    if (prev === undefined) delete process.env[name]
    else process.env[name] = prev
  })
}

test('an unset knob reads as absent', (t) => {
  withEnv(t, 'MIRALL_TEST_JSON', undefined)
  t.is(envJson('MIRALL_TEST_JSON'), null)
})

test('a well-formed object or array is parsed', (t) => {
  withEnv(t, 'MIRALL_TEST_JSON', '[{"host":"127.0.0.1","port":49737}]')
  t.alike(envJson('MIRALL_TEST_JSON'), [{ host: '127.0.0.1', port: 49737 }])
})

// REGRESSION (FIX-ENVJSON-1: MIRALL_DHT_BOOTSTRAP was JSON.parse'd bare inside the worker
// bootstrap build, so a malformed value threw there and pear:startWorker rejected with a JSON
// syntax error — the app came up with no worker at all.)
test('REGRESSION (FIX-ENVJSON-1): a malformed value is ignored, not thrown', (t) => {
  withEnv(t, 'MIRALL_TEST_JSON', 'not json at all')
  const { result, warnings } = captureWarnings(() => envJson('MIRALL_TEST_JSON'))
  t.is(result, null, 'the caller sees an absent knob')
  t.is(warnings.length, 1, 'and is told why')
  t.ok(warnings[0].includes('MIRALL_TEST_JSON'), 'the warning names the variable')
})

// The warning reaches the main log ring, which a diagnostics bundle ships. JSON.parse's own
// message quotes a fragment of the input, and these knobs carry host/port lists.
test('REGRESSION (FIX-ENVJSON-1): the warning never repeats the value', (t) => {
  withEnv(t, 'MIRALL_TEST_JSON', '[{"host":"203.0.113.9","port":49737},') // truncated → malformed
  const { warnings } = captureWarnings(() => envJson('MIRALL_TEST_JSON'))
  t.absent(warnings[0].includes('203.0.113.9'), 'no address in the log')
  t.absent(warnings[0].includes('49737'), 'no port in the log')
})

// A JSON scalar parses fine but is not a shape any knob declares, and passing it on hands the
// consumer (hyperswarm's bootstrap list, the flag merge) a value it cannot use.
test('a scalar is refused like a malformed value', (t) => {
  withEnv(t, 'MIRALL_TEST_JSON', '5')
  const { result, warnings } = captureWarnings(() => envJson('MIRALL_TEST_JSON'))
  t.is(result, null)
  t.is(warnings.length, 1, 'and it warns rather than failing silently')
})

// main.js only runs inside Electron, so the wiring is pinned by source — the
// renderer-cancellation-wiring.test.js pattern.
test('REGRESSION (FIX-ENVJSON-1): the worker bootstrap reads the DHT knob through envJson', (t) => {
  t.ok(mainSrc.includes("dhtBootstrap: envJson('MIRALL_DHT_BOOTSTRAP')"),
    'the bootstrap field goes through the swallow-and-warn helper')
  t.absent(/JSON\.parse\(process\.env\.MIRALL_DHT_BOOTSTRAP\)/.test(mainSrc),
    'and no bare parse is left to throw inside getWorker')
})
