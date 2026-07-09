// REGRESSION (FIX: failed file row grew taller + toast too narrow) — LOCAL/dev-machine
// only, spawns a real Electron GUI process. Mounts real <FileCard>s and the real
// <ToastContainer> and asserts (a) a failed row keeps the at-rest row height while
// still showing the error, and (b) toasts cap at 720px so long file names fit.
//
//   node test/frontend-layout/run-filecard.mjs            (builds, then runs)
//   node test/frontend-layout/run-filecard.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-filecard.html', height: 700 })

console.log('\n──────── FileCard error-state / toast-width harness ────────')
console.log(`baseline row height : ${out.baselineHeight}px`)
console.log(`failed row height   : ${out.errorHeight}px (must equal baseline)`)
console.log(`failed row (long)   : ${out.errorLongHeight}px (must equal baseline)`)
console.log(`error visible       : ${out.alertVisible} ("${out.alertText}", inside card: ${out.alertInsideCard})`)
console.log(`toast width (short) : ${out.toastShortWidth}px (>=280, below cap)`)
console.log(`toast width (long)  : ${out.toastLongWidth}px (must hit the 720px cap)`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} failed rows keep the resting height and toasts cap at 720px`)
process.exit(pass ? 0 : 1)
