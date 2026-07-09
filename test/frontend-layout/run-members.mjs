// Members-panel layout regression test (LOCAL/dev-machine only — spawns a real
// Electron GUI process, like the agent-desktop frontend suite). Mounts the real
// <SpaceView> in real Chromium and asserts the expanded Members card hugs its
// content for a small roster (collapsing the empty space below it) while still
// capping at the available height and scrolling internally for a large one.
//
//   node test/frontend-layout/run-members.mjs            (builds, then runs)
//   node test/frontend-layout/run-members.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

// A tall window so a small roster genuinely leaves empty space below the members
// card — the condition under which the collapse is observable.
const out = await runHarness({ html: 'harness-members.html', height: 1200 })

const fmtPhase = (label, p) => {
  if (!p) return `      ${label}: (not measured)`
  return `      ${label}: rows=${p.memberRows} col(h=${p.colHeight} bottom=${p.colBottom}) ` +
    `card(h=${p.cardHeight} bottom=${p.cardBottom}) gapBelow=${p.gapBelow} ` +
    `scroll(client=${p.scrollClientH} content=${p.scrollContentH} overflow=${p.scrollOverflow})`
}

console.log('\n──────── SpaceView Members-panel layout harness ────────')
console.log(`innerHeight            : ${out.innerHeight}px`)
console.log('measurements:')
console.log(fmtPhase('few ', out.few))
console.log(fmtPhase('many', out.many))
console.log(`few  ok (card hugs content, no inner scroll) : ${out.fewOk}`)
console.log(`many ok (card caps, list scrolls internally) : ${out.manyOk}`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} expanded Members card sizes to its content (and caps + scrolls when it overflows)` +
  (pass ? '' : '  — with a small roster the card must not stretch to the column bottom'))
process.exit(pass ? 0 : 1)
