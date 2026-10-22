// Text-truncation test (LOCAL/dev-machine only — spawns a real Electron GUI process, like the
// agent-desktop frontend suite). Mounts the real <PathRow>, file cards, a folder row with a file row
// and a share card in narrow fields and asserts none escapes its field, that a path keeps its final
// segment, and that a name is middle-truncated with its full form in its card's hover title.
//
//   node test/frontend-layout/run-truncation.mjs            (builds, then runs)
//   node test/frontend-layout/run-truncation.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-truncation.html', width: 600, height: 1100 })

console.log('\n──────── Text truncation harness ────────')
console.log(`path  : overflow ${out.pathOverflow}px (<= 0) · longer than its field ${out.pathScrolls} · scrolled to its end ${out.pathShowsEnd}`)
for (const key of ['file', 'short', 'folder', 'nested', 'share']) {
  const r = out[key]
  if (r) console.log(`${key.padEnd(6)}: overflow ${r.overflow}px (<= 0) · shown "${r.shown}" · card title "${r.cardTitle}"`)
}
console.log(`lane  : title on the progress bar "${out.laneTitle}" (not the file name) · name's natural width ${out.laneIntrinsicShare}× the full name (>= 0.98)`)
console.log(`share : title on Browse files "${out.shareActionTitle}"`)
if (out.error) console.log(`error: ${out.error}`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} long paths keep their ending; names keep both ends; the whole card shows the full name on hover`)
process.exit(pass ? 0 : 1)
