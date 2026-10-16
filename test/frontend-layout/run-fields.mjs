// Field contrast — LOCAL/dev only, spawns a real Electron GUI process. Mounts real fields, the
// restore card, the list filter and both switch states, and asserts in light and dark that every
// placeholder and error clears 4.5:1, every field stands apart from its card, and every switch
// clears 3:1.
//
//   node test/frontend-layout/run-fields.mjs            (builds, then runs)
//   node test/frontend-layout/run-fields.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-fields.html', height: 1400 })

console.log('\n──────── field contrast harness ────────')
for (const m of out.themes) {
  console.log(`${m.theme.padEnd(5)}: placeholder ${m.placeholder} · value ${m.value} · field ${m.fieldFill}`)
  for (const [name, ratio] of Object.entries(m.ratios)) console.log(`       ${name.padEnd(34)} ${ratio.toFixed(2)}:1`)
}
for (const f of out.failures) console.log(`  ${f}`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} placeholders and errors clear 4.5:1, fields stand off their cards, switches clear 3:1, in both themes`)
process.exit(pass ? 0 : 1)
