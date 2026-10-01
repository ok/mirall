// Callout tones — LOCAL/dev only, spawns a real Electron GUI process. Mounts the real <Callout> in
// both tones beside a real <TextField> and asserts, in light and dark, that a note sits on the
// field gray, a warning on the amber container, and neither on the surface-container-high plate.
//
//   node test/frontend-layout/run-callouts.mjs            (builds, then runs)
//   node test/frontend-layout/run-callouts.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-callouts.html' })

console.log('\n──────── callout tone harness ────────')
for (const m of out.themes) {
  console.log(`${m.theme.padEnd(5)}: field ${m.field} · note ${m.note} · warning ${m.warning} · warning-container ${m.warningContainer} · high ${m.high}`)
}
for (const f of out.failures) console.log(`  ${f}`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} notes sit on the field gray, warnings on the amber container, never on the -high plate, in both themes`)
process.exit(pass ? 0 : 1)
