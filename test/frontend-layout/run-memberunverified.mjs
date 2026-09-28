// Unverified member pill harness (LOCAL/dev-machine only — spawns a real Electron GUI process).
// Mounts the real <SpaceScreen> in real Chromium and asserts that a roster entry flagged unverified
// wears the pill as one text node in place of the online icon, and loses it in place once cleared.
//
//   node test/frontend-layout/run-memberunverified.mjs            (builds, then runs)
//   node test/frontend-layout/run-memberunverified.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-memberunverified.html', height: 1200 })

console.log('\n──────── unverified member pill harness ────────')
console.log(`pill on the flagged row : ${out.pillShown}`)
console.log(`one text node           : ${out.oneNode}`)
console.log(`online icon withheld    : ${out.iconWithheld}`)
console.log(`self row has no pill    : ${out.selfClean}`)
console.log(`cleared in place        : ${out.clearedInPlace}`)
if (out.error) console.log(`error                   : ${out.error}`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} an unverified member is labelled as one accessible string, and only while flagged`)
process.exit(pass ? 0 : 1)
