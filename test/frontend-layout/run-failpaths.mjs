// REGRESSION (issue #375: user actions with no failure path) — LOCAL/dev only, spawns a real
// Electron GUI process. Fails the worker and the clipboard under the real screens and asserts each
// control ends usable, honest and announced, with nothing escaping.
//
//   node test/frontend-layout/run-failpaths.mjs            (builds, then runs)
//   node test/frontend-layout/run-failpaths.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-failpaths.html', width: 900, height: 900 })

const j = (v) => JSON.stringify(v)
console.log('\n──────── Action failure-path harness ────────')
console.log(`profile save : ${j(out.save)}`)
console.log(`log purge    : ${j(out.purge)}`)
console.log(`verbose      : ${j(out.verbose)}`)
console.log(`copy button  : ${j(out.copy)}`)
console.log(`invite copy  : ${j(out.invite)}`)
console.log(`copy overlap : ${j(out.overlap)}`)
console.log(`unhandled    : ${out.unhandled} escaped promise rejection(s)`)
if (out.error) console.log(`error: ${out.error}`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} every failed action leaves its control usable, claims nothing, and says why`)
process.exit(pass ? 0 : 1)
