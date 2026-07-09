// Folder-card hit-area test (LOCAL/dev-machine only — spawns a real Electron GUI
// process, like the agent-desktop frontend suite). Mounts the real <ShareCard> in
// real Chromium and asserts the nav button is full-bleed and the padding strips
// navigate, while the action buttons stay clickable.
//
//   node test/frontend-layout/run-sharecard.mjs            (builds, then runs)
//   node test/frontend-layout/run-sharecard.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-sharecard.html', height: 600 })

console.log('\n──────── ShareCard hit-area harness ────────')
console.log(`nav inset top : ${out.navInsetTop}px (must be ~0; was ~20 pre-fix)`)
console.log(`full-bleed    : ${out.fullBleed}`)
console.log(`hit icon      : ${out.hitIcon}`)
console.log(`hit avatar    : ${out.hitAvatar}`)
console.log(`body sweep    : ${out.bodySamples - out.bodyMisses}/${out.bodySamples} points navigate (misses=${out.bodyMisses})`)
console.log(`More reachable: ${out.moreReachable}`)
console.log(`chevron reach.: ${out.chevronReachable}`)
console.log(`header stacks  : ${out.headerWins} (z-10 sibling paints over card; tested=${out.headerStackTested})`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} folder card is fully clickable (body incl. icon/avatar navigates; action buttons stay live)`)
process.exit(pass ? 0 : 1)
