// Row action-swap focus test (LOCAL/dev-machine only — spawns a real Electron GUI process).
// REGRESSION (FIX-DLTO-R12: a keyboard pick in a row's Download-to menu started the download, the
// trigger gave way to Pause and focus fell to the page). Mounts a real folder <FileRow>, picks from
// its menu by keyboard, changes the row's status as a refetch does, and asserts focus lands on the
// lane's new control, stays in the lane when it has none, and is never taken back from elsewhere.
//
//   node test/frontend-layout/run-lanefocus.mjs            (builds, then runs)
//   node test/frontend-layout/run-lanefocus.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-lanefocus.html', width: 900, height: 500, focus: true })

console.log('\n──────── Row action-swap focus harness ────────')
console.log(`picked       : ${out.picked ?? 'NOTHING (the menu pick never reached the row)'}`)
for (const s of out.steps ?? []) console.log(`${s.pass ? 'ok  ' : 'FAIL'} ${s.name} (focus: ${s.focus})`)
if (out.error) console.log(`error        : ${out.error}`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} focus stays with the row's lane when its control is swapped`)
process.exit(pass ? 0 : 1)
