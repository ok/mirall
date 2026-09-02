// Focus-ring clearance test (LOCAL/dev-machine only — spawns a real Electron GUI process, like the
// agent-desktop frontend suite). Mounts the real <FolderView> in real Chromium and asserts every
// fully-visible focusable control has room for its 2px `focus-visible:ring-2` inside every
// clipping ancestor. Catches the class of regression where an `overflow-hidden` wrapper or a
// scroll pane sits flush against a control and shaves the ring off.
//
//   node test/frontend-layout/run-focusring.mjs            (builds, then runs)
//   node test/frontend-layout/run-focusring.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-focusring.html', width: 1400, height: 900 })

console.log('\n──────── Focus-ring clearance harness ────────')
console.log(`ring         : ${out.ring}px, painted outside the border box`)
console.log(`controls     : ${out.checked} checked · ${out.skipped} skipped (scrolled out or zero-size)`)
for (const o of out.offenders ?? []) {
  console.log(`  CLIPPED    : ${o.tag}.${o.cls} — ${o.side} room ${o.room}px, clipped by ${o.clipper}`)
}
if (out.error) console.log(`error        : ${out.error}`)

const pass = out.pass === true && out.checked > 0
console.log(`\n${pass ? 'ok  ' : 'FAIL'} every visible control has ${out.ring}px of clearance for its focus ring`)
process.exit(pass ? 0 : 1)
