// Folder selection-column test (LOCAL/dev-machine only — spawns a real Electron GUI process).
// Mounts the real <FolderScreen> on a browse folder three levels deep at two widths, opens the
// column with the select-all chord pressed on "Downloads to", and asserts the column's geometry: one
// x for every box, ring room inside the pane, rows aligned with the controls row at rest, and no
// document overflow; that the focus the hidden button held is on the top box
// (REGRESSION (FIX-DLTO-R18: the button left the row with focus in it)); that mounting the screen
// reads no folder reachability (REGRESSION (FIX-DLTO-R30)); and that acting on an offline folder
// re-probes it (REGRESSION (FIX-DLTO-R23)).
//
//   node test/frontend-layout/run-folderselecting.mjs            (builds, then runs)
//   node test/frontend-layout/run-folderselecting.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

let pass = true
for (const width of [1024, 1536]) {
  const out = await runHarness({ html: 'harness-folderselecting.html', width, height: 900, focus: true })
  process.argv.push('--no-build')
  console.log(`\n──────── Folder selection-column harness @ ${width}px ────────`)
  console.log(`at rest      : first row left ${out.restRowLeft}px, controls row left ${out.restControlsLeft}px → ${out.atRestAligned ? 'aligned' : 'MISALIGNED'}`)
  console.log(`selecting    : ${out.boxes} boxes at x = [${(out.boxLefts || []).join(', ')}] → ${out.oneX ? 'one x' : 'SCATTERED'}`)
  console.log(`ring room    : ${out.ringRoom}px inside the pane (needs 2px)`)
  console.log(`selection bar: left ${out.barLeft}px, filter left ${out.filterLeft}px → ${out.barAligned ? 'aligned' : 'MISALIGNED'}`)
  console.log(`overflow     : at rest ${out.overflowAtRest}, selecting ${out.overflowSelecting}`)
  const d = out.downloadsTo
  console.log(`downloads to : ${d && d.found ? `"${d.name}" at ${d.left}–${d.right}px, filter ends ${d.filterRight}px, Expand all at ${d.expandLeft}px → ${d.between ? 'between' : 'OUT OF PLACE'}` : 'NOT FOUND'}; while selecting ${out.downloadsToHiddenSelecting ? 'hidden' : 'SHOWN'}`)
  console.log(`focus        : after ⌘A on Downloads to → ${out.focusAfterChord} (must be the top box)`)
  console.log(`roots reads  : ${out.rootsReadsOnMount} on mount (must be 0)`)
  console.log(`offline      : main half ${out.inertWhenOffline ? 'inert' : 'NOT INERT'}; click ${out.reprobedOnClick ? 're-probes' : 'DOES NOT RE-PROBE'} → ${out.enabledAfterReprobe ? 'enabled again' : 'STILL BLOCKED'}; menu open ${out.reprobedOnOpen ? 're-probes' : 'DOES NOT RE-PROBE'}`)
  const s = out.split
  console.log(`label/name   : Downloads to "${d?.visible}" in "${d?.name}" → ${d?.labelInName ? 'contained' : 'NOT CONTAINED'}; main half "${s?.visible}" in "${s?.name}" → ${s?.labelInName ? 'contained' : 'NOT CONTAINED'}`)
  console.log(`split button : ${s && s.found ? `"${s.name}", heights [${s.heights}] tops [${s.tops}] baselines [${s.baselines}] → ${s.aligned ? 'aligned' : 'MISALIGNED'}, ${s.joined ? 'joined' : 'APART'}, ${s.pressFlat ? 'presses flat' : 'HALVES SHRINK APART'}` : 'NOT FOUND'}; Cancel N ${s && s.cancelShown ? 'SHOWN' : 'absent'}`)
  if (out.error) console.log(`error        : ${out.error}`)
  pass = pass && out.pass === true
}
console.log(`\n${pass ? 'ok  ' : 'FAIL'} the selection column keeps one x, ring room and no overflow at both widths; Downloads to sits between filter and Expand all; the split button lines up with Done`)
process.exit(pass ? 0 : 1)
