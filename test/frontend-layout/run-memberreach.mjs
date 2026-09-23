// Member-reach label ARIA harness (LOCAL/dev-machine only — spawns a real Electron GUI process).
// Mounts the real <SpaceScreen> in real Chromium and asserts the roster's presence line carries the
// whole state as one text node, in three distinguishable strings, with no live region.
//
//   node test/frontend-layout/run-memberreach.mjs            (builds, then runs)
//   node test/frontend-layout/run-memberreach.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-memberreach.html', height: 1200 })

console.log('\n──────── member reach label harness ────────')
console.log(`relayed row line       : ${out.labels ? out.labels.relayedRow : '(not measured)'}`)
console.log(`direct row line        : ${out.labels ? out.labels.directRow : '(not measured)'}`)
console.log(`one text node per row  : ${out.oneNodePerRow}`)
console.log(`presence dots hidden   : ${out.dotsHidden}`)
console.log(`falls back in place    : ${out.fallsBackInPlace}`)
console.log(`no aria-live region    : ${out.noLiveRegion}`)
if (out.error) console.log(`error                  : ${out.error}`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} the roster names the reach as one accessible string per row`)
process.exit(pass ? 0 : 1)
