import test from 'brittle'
import { makeFetchDiag } from '../../src/shared/transfer/backends/overlay/overlay-backend.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'

// Capture console.{log,warn,error} around a body. The logger maps debug/info →
// console.log, warn → console.warn, gated on the runtime `verbose` flag.
function capture(fn) {
  const out = { log: [], warn: [], error: [] }
  const orig = { log: console.log, warn: console.warn, error: console.error }
  console.log = (...a) => out.log.push(a.join(' '))
  console.warn = (...a) => out.warn.push(a.join(' '))
  console.error = (...a) => out.error.push(a.join(' '))
  try { fn() } finally { Object.assign(console, orig) }
  return out
}

// Set `verbose` without clobbering the rest of runtime config (buildConfig is a
// full rebuild from `next` only — merge over the current config), and restore the
// prior config on teardown so the global flag never leaks to sibling tests.
function setVerbose(t, value) {
  const prev = getRuntimeConfig()
  setRuntimeConfig({ ...prev, verbose: value })
  t.teardown(() => setRuntimeConfig(prev))
}

const STOPS = ['paused', 'cancelled', 'superseded', 'no-holder']

// REGRESSION (FIX-1: a deliberate pause logged as a WARN "INCOMPLETE … gave up").
// Pausing an in-flight overlay download cancels the chunk scheduler, which the
// engine routed to diag.finish(false) → log.warn "gave up after Ns". A user
// pausing is normal control flow, not a failure: a deliberate-stop outcome must
// never emit a WARN.
test('REGRESSION: a deliberate-stop outcome never warns (at the default log level)', (t) => {
  setVerbose(t, false) // production default: only WARN+ reaches the console
  for (const outcome of STOPS) {
    const out = capture(() => makeFetchDiag('loose download', 'big.mp4', 49940299717, 'abc').finish(outcome))
    t.is(out.warn.length, 0, `finish('${outcome}') emits no WARN`)
    t.absent(out.log.join('\n').includes('gave up'), `finish('${outcome}') never says "gave up"`)
  }
})

test('a genuine give-up still warns "INCOMPLETE … gave up"', (t) => {
  setVerbose(t, false)
  const out = capture(() => makeFetchDiag('loose download', 'big.mp4', 100, 'abc').finish('failed'))
  t.is(out.warn.length, 1, 'failure is a single WARN')
  t.ok(out.warn[0].includes('INCOMPLETE') && out.warn[0].includes('gave up'), 'preserves the failure wording')
})

// An unrecognized outcome (a typo / a future renamed state) must FAIL SAFE to a
// WARN — never silently land in the deliberate-stop debug bucket, which would make
// a real give-up invisible at the default log level.
test('an unknown outcome fails safe to a WARN, tagged with the raw value', (t) => {
  setVerbose(t, false)
  const out = capture(() => makeFetchDiag('loose download', 'big.mp4', 100, 'abc').finish('faild'))
  t.is(out.warn.length, 1, 'unknown outcome warns (does not vanish at debug)')
  t.ok(out.warn[0].includes('INCOMPLETE') && out.warn[0].includes("outcome='faild'"), 'names the offending outcome')
})

test('success logs done, not a warning', (t) => {
  setVerbose(t, false)
  const out = capture(() => makeFetchDiag('loose download', 'big.mp4', 100, 'abc').finish('done'))
  t.is(out.warn.length, 0, 'success never warns')
})

test('with verbose on, a deliberate stop is a debug line carrying the outcome + byte position', (t) => {
  setVerbose(t, true) // debug/info now reach console.log
  const diag = makeFetchDiag('loose download', 'big.mp4', 49940299717, 'abc')
  diag.onProgress(178343571) // the bytes reached before the pause
  const out = capture(() => diag.finish('paused'))
  t.is(out.warn.length, 0, 'still no WARN under verbose')
  const line = out.log.find((l) => l.includes('paused'))
  t.ok(line, 'a debug line names the outcome')
  t.ok(line.includes('178343571/49940299717'), 'reports where it stopped')
})
