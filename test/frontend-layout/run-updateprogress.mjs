// About update-card download test (LOCAL/dev-machine only — spawns a real Electron GUI process).
// Mounts the real <UpdateVerdictBanner> in each download state and asserts the bar's place and
// ARIA state.
//
//   node test/frontend-layout/run-updateprogress.mjs            (builds, then runs)
//   node test/frontend-layout/run-updateprogress.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-updateprogress.html', height: 900 })

console.log('\n──────── About update-card download harness ────────')
for (const [name, c] of Object.entries(out.cards)) {
  console.log(`${name.padEnd(15)}: bar = ${c.hasBar}, in live region = ${c.barInLiveRegion}, aria-valuenow = ${c.valueNow}, sweep = ${c.sweep}, shown = "${c.pctText}", valuetext = "${c.valueText}", body = "${c.body}"`)
}

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} the update card shows a bar only while downloading, outside its live region, with the right value per state`)
process.exit(pass ? 0 : 1)
