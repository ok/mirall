// Grouped-row focus test (LOCAL/dev-machine only — spawns a real Electron GUI process, like the
// agent-desktop frontend suite). Focuses every full-width row of a rounded settings group and
// asserts the ring is inset, follows the group's corners where the row meets its edge, and the row
// is tinted while focused.
//
//   node test/frontend-layout/run-rowfocus.mjs            (builds, then runs)
//   node test/frontend-layout/run-rowfocus.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-rowfocus.html', width: 1200, height: 900, focus: true })

console.log('\n──────── Grouped-row focus harness ────────')
console.log(`rows       : ${out.checked} focused · ${out.edgeRows} group edges checked`)
for (const o of out.offenders ?? []) console.log(`  OFFENDER : ${o.row} — ${o.problem}`)
if (out.error) console.log(`error      : ${out.error}`)

const pass = out.pass === true && out.checked > 0 && out.edgeRows > 0
console.log(`\n${pass ? 'ok  ' : 'FAIL'} every grouped row's focus ring fits its card`)
process.exit(pass ? 0 : 1)
