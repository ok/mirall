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
if (out.error) console.log(`error        : ${out.error}`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} the space's selection column keeps one x with the header pinned and no overflow`)
process.exit(pass ? 0 : 1)
