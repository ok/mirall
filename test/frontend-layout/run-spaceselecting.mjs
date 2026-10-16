// Space selection-column test (LOCAL/dev-machine only — spawns a real Electron GUI process).
// Mounts the real <SpaceScreen> with folders and loose files at 1024px, opens the column through
// the top box, and asserts one x for every box, the folder section gone, the Files Shared header
// still pinned flush on the scrollport, and no document overflow.
//
//   node test/frontend-layout/run-spaceselecting.mjs            (builds, then runs)
//   node test/frontend-layout/run-spaceselecting.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-spaceselecting.html', width: 1024, height: 870 })

console.log('\n──────── Space selection-column harness ────────')
console.log(`selecting    : ${out.boxes} boxes at x = [${(out.boxLefts || []).join(', ')}] → ${out.oneX ? 'one x' : 'SCATTERED'}`)
console.log(`folders      : ${out.foldersHidden ? 'hidden while selecting' : 'STILL SHOWN'}`)
console.log(`sticky header: gap ${out.headerGap}px → ${out.headerPinned ? 'pinned' : 'NOT PINNED'}`)
console.log(`selection bar: left ${out.barLeft}px, filter left ${out.filterLeft}px → ${out.barAligned ? 'aligned' : 'MISALIGNED'}`)
console.log(`overflow     : ${out.overflow}`)
const d = out.downloadsTo
console.log(`downloads to : ${d && d.found ? `"${d.name}" at ${d.left}–${d.right}px, filter ends ${d.filterRight}px → ${d.between ? 'right of the filter' : 'OUT OF PLACE'}` : 'NOT FOUND'}; while selecting ${out.downloadsToHiddenSelecting ? 'hidden' : 'SHOWN'}`)
const off = out.downloadsToOffline
console.log(`label/name   : Downloads to "${d?.visible}" in "${d?.name}" → ${d?.labelInName ? 'contained' : 'NOT CONTAINED'}; not connected "${off?.visible}" in "${off?.name}" → ${off?.labelInName ? 'contained' : 'NOT CONTAINED'}`)
const s = out.split
console.log(`label/name   : main half "${s?.visible}" in "${s?.name}" → ${s?.labelInName ? 'contained' : 'NOT CONTAINED'}`)
console.log(`split button : ${s && s.found ? `"${s.name}", heights [${s.heights}] tops [${s.tops}] baselines [${s.baselines}] → ${s.aligned ? 'aligned' : 'MISALIGNED'}, ${s.joined ? 'joined' : 'APART'}, ${s.pressFlat ? 'presses flat' : 'HALVES SHRINK APART'}` : 'NOT FOUND'}; Cancel N ${s && s.cancelShown ? 'SHOWN' : 'absent'}`)
if (out.error) console.log(`error        : ${out.error}`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} the space's selection column keeps one x with the header pinned and no overflow; Downloads to sits right of the filter; the split button lines up with Done`)
process.exit(pass ? 0 : 1)
