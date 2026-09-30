// Scroll-gutter render-loop test (LOCAL/dev-machine only — spawns a real Electron GUI process, like
// the agent-desktop frontend suite). Walks <SpacesScreen> across its overflow boundary 1px at a time
// in production React and asserts the list settles at every height: no nested-update crash (#185), no
// padding flag that flips within one step, and both states (padded and not) actually reached.
//
//   node test/frontend-layout/run-overflowloop.mjs            (builds, then runs)
//   node test/frontend-layout/run-overflowloop.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-overflowloop.html', deadlineMs: 120000 })

console.log('\n──────── scroll-gutter render-loop harness ────────')
console.log(`heights walked         : ${out.steps}`)
console.log(`reached padded + bare  : ${out.settledBoth}`)
console.log(`render crash           : ${out.crash ?? 'none'}`)
console.log(`oscillating consumer   : ${out.oscillatorCrash ?? 'survived'} (${out.oscillatorCommits} renders)`)
console.log(`steps that flip-flopped: ${out.flips.length}`)
for (const f of out.flips) {
  console.log(`      banner-h=-${f.bannerH}px class changes=${f.classChanges} scrollH=${f.scrollH} clientH=${f.clientH} padded=${f.padded}`)
}
console.log(out.pass ? '\nPASS' : '\nFAIL')
process.exit(out.pass ? 0 : 1)
