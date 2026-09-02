// Space-screen sticky-header test (LOCAL/dev-machine only — spawns a real Electron GUI process,
// like the agent-desktop frontend suite). Mounts the real <SpaceView>, scrolls the list so rows
// pass behind the pinned "Folders Shared" / "Files Shared" headers, and asserts each header sits
// flush on the scrollport with no sliver of a row showing above it. Prints every header it
// measured so a failure is self-diagnosing.
//
//   node test/frontend-layout/run-stickyheader.mjs            (builds, then runs)
//   node test/frontend-layout/run-stickyheader.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-stickyheader.html' })

console.log('\n──────── SpaceView sticky-header harness ────────')
console.log(`innerHeight            : ${out.innerHeight}px`)
console.log(`share cards rendered   : ${out.shareCards}`)
console.log(`list pane scrolls      : ${out.paneScrolls}`)
if (out.error) console.log(`error                  : ${out.error}`)
console.log('measurements (gap = band above the pinned header, leak = row visible in it):')
for (const p of out.phases || []) {
  console.log(`      pane scrollTop=${p.paneScrollTop}`)
  for (const h of p.headers) {
    console.log(`        "${h.label}"  ${h.pinned ? 'PINNED' : 'in flow'}  gap=${h.gap}px leak=${h.leak}px rowsBehind=${h.rowsBehind}`)
  }
}
console.log(`worst gap / leak       : ${out.worstGap}px / ${out.worstLeak}px  (over ${out.headersPinned} pinned header(s))`)
console.log(`top control clearance  : ${out.topControlClearance}px at rest (focus ring needs 2px)`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} the pinned section headers cover the top of the list pane` +
  (pass ? '' : '  — a slice of the row scrolling behind a header stays visible above it,' +
    ' or the topmost control lost the room for its focus ring'))
process.exit(pass ? 0 : 1)
