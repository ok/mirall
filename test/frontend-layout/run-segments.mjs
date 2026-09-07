// Segmented-control width-stability test (LOCAL/dev-machine only — spawns a real Electron GUI
// process, like the agent-desktop frontend suite). Mounts the real <SegmentedControl> with the
// shipped label sets, clicks every segment in turn and asserts the track — and each segment in it
// — keeps exactly the same size, while the pressed label still paints bolder than the rest.
//
//   node test/frontend-layout/run-segments.mjs            (builds, then runs)
//   node test/frontend-layout/run-segments.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-segments.html', width: 900, height: 500 })

console.log('\n──────── Segmented-control harness ────────')
for (const g of out.groups ?? []) {
  const widths = [...new Set(g.trackWidths)]
  console.log(`${g.id.padEnd(11)}: ${g.segments} segments · track ${widths.join(' / ')}px · weight ${g.unselectedWeights[0]}→${g.selectedWeights[0]}`)
  if (!g.stable) console.log(`  JITTER   : per-segment widths ${[...new Set(g.segmentWidths)].join('  |  ')}`)
  if (!g.weightMoves) console.log('  NO-OP    : the selected segment no longer reads bolder — this harness proves nothing')
}
if (out.error) console.log(`error      : ${out.error}`)

const pass = out.pass === true && (out.groups?.length ?? 0) === 3
console.log(`\n${pass ? 'ok  ' : 'FAIL'} selecting a segment never resizes the control`)
process.exit(pass ? 0 : 1)
