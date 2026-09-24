// REGRESSION (FIX-DARKSHADOW: a tinted band under the first-run header in dark mode) — LOCAL/dev
// only, spawns a real Electron GUI process. Mounts the real <OnboardingScreen> and <TopNav> and
// asserts the ambient mauve shadow lifts them in light mode and is gone in dark mode.
//
//   node test/frontend-layout/run-darkshadow.mjs            (builds, then runs)
//   node test/frontend-layout/run-darkshadow.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-darkshadow.html' })

const fmt = (list) => list.map((t) => `      <${t.tag} class="${t.cls}">  ${t.boxShadow}`).join('\n')

console.log('\n──────── dark-mode chrome shadow harness ────────')
console.log(`light: tinted surfaces : ${out.lightTinted.length}`)
console.log(fmt(out.lightTinted))
console.log(`dark : tinted surfaces : ${out.darkTinted.length}`)
if (out.darkTinted.length) console.log(fmt(out.darkTinted))

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} the mauve lift is dropped in dark mode on the first-run screen and the top bar`)
process.exit(pass ? 0 : 1)
