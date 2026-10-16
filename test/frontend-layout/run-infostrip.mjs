// Info strip contrast — LOCAL/dev only, spawns a real Electron GUI process. Mounts the real batch
// strip and folder work strip on the page and asserts, in light and dark, that the strip stands off
// the page and its sentence, lane and button read on it.
//
//   node test/frontend-layout/run-infostrip.mjs            (builds, then runs)
//   node test/frontend-layout/run-infostrip.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-infostrip.html' })

const n = (v) => (v === null ? '  —  ' : `${v.toFixed(2)}`)
console.log('\n──────── info strip contrast harness ────────')
for (const t of out.themes ?? []) {
  for (const m of t.strips) {
    console.log(`${t.theme.padEnd(5)} ${m.strip.padEnd(9)}: off page ${n(m.offPage)} · text ${n(m.sentence)} · meta ${n(m.meta)} · fill/track ${n(m.fillVsTrack)} · sweep/track ${n(m.sweepVsTrack)} · track/strip ${n(m.trackVsStrip)} · button ${n(m.buttonLabel)}`)
  }
}
if (out.error) console.log(`  error: ${out.error}`)
for (const f of out.failures ?? []) console.log(`  ${f}`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} the busy strips stand off the page and their text, lane and button read, in both themes`)
process.exit(pass ? 0 : 1)
