// Folder-screen geometry test (LOCAL/dev-machine only — spawns a real Electron GUI process, like
// the agent-desktop frontend suite). Mounts the real <FolderView> in real Chromium and asserts
// (1) every fully-visible focusable control has room for its 2px `focus-visible:ring-2` inside
// every clipping ancestor, and (2) the filter row and the file rows share a right edge.
//
//   node test/frontend-layout/run-geometry.mjs            (builds, then runs)
//   node test/frontend-layout/run-geometry.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-geometry.html', width: 1400, height: 900 })

console.log('\n──────── Folder-screen geometry harness ────────')
console.log(`ring         : ${out.ring}px, painted outside the border box`)
console.log(`controls     : ${out.checked} checked · ${out.skipped} skipped (scrolled out or zero-size)`)
for (const o of out.offenders ?? []) {
  console.log(`  CLIPPED    : ${o.tag}.${o.cls} — ${o.side} room ${o.room}px, clipped by ${o.clipper}`)
}
console.log(`edges        : filter row vs file rows ${out.ragged}px apart (0 = flush)`)
console.log(`sticky       : scrolled 400px, filter row sits ${out.stuckBy}px below the scrollport top (<= 5)`)
if (out.error) console.log(`error        : ${out.error}`)

const pass = out.pass === true && out.checked > 0
console.log(`\n${pass ? 'ok  ' : 'FAIL'} rings have ${out.ring}px of clearance and the filter row shares the file rows' right edge`)
process.exit(pass ? 0 : 1)
