// Folder selection-column test (LOCAL/dev-machine only — spawns a real Electron GUI process).
// Mounts the real <FolderScreen> on a browse folder three levels deep at two widths, opens the
// column through the top box, and asserts the column's geometry: one x for every box, ring room
// inside the pane, rows aligned with the controls row at rest, and no document overflow.
//
//   node test/frontend-layout/run-folderselecting.mjs            (builds, then runs)
//   node test/frontend-layout/run-folderselecting.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

let pass = true
for (const width of [1024, 1536]) {
  const out = await runHarness({ html: 'harness-folderselecting.html', width, height: 900 })
  process.argv.push('--no-build')
  console.log(`\n──────── Folder selection-column harness @ ${width}px ────────`)
  console.log(`at rest      : first row left ${out.restRowLeft}px, controls row left ${out.restControlsLeft}px → ${out.atRestAligned ? 'aligned' : 'MISALIGNED'}`)
  console.log(`selecting    : ${out.boxes} boxes at x = [${(out.boxLefts || []).join(', ')}] → ${out.oneX ? 'one x' : 'SCATTERED'}`)
  console.log(`ring room    : ${out.ringRoom}px inside the pane (needs 2px)`)
  console.log(`selection bar: left ${out.barLeft}px, filter left ${out.filterLeft}px → ${out.barAligned ? 'aligned' : 'MISALIGNED'}`)
  console.log(`overflow     : at rest ${out.overflowAtRest}, selecting ${out.overflowSelecting}`)
  if (out.error) console.log(`error        : ${out.error}`)
  pass = pass && out.pass === true
}
console.log(`\n${pass ? 'ok  ' : 'FAIL'} the selection column keeps one x, ring room and no overflow at both widths`)
process.exit(pass ? 0 : 1)
