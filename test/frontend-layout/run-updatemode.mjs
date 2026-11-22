// About update-mode test (LOCAL/dev-machine only — spawns a real Electron GUI process). Mounts the
// real <UpdateModeRow>, <UpdateVerdictBanner> and <UpdateBanner> and asserts what each update mode
// and waiting state exposes, and that the mode row fits its card in every language.
//
//   node test/frontend-layout/run-updatemode.mjs            (builds, then runs)
//   node test/frontend-layout/run-updatemode.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-updatemode.html', height: 1400 })

console.log('\n──────── About update-mode harness ────────')
for (const [name, ok] of Object.entries(out.checks)) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
for (const [name, value] of Object.entries(out.detail)) console.log(`     ${name}: ${value}`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} the update mode, its waiting states and its banner expose what they promise`)
process.exit(pass ? 0 : 1)
