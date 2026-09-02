// People sidebar tile test (LOCAL/dev-machine only — spawns a real Electron GUI process,
// like the agent-desktop frontend suite). Mounts the real <FolderPeopleCard> in real Chromium and
// asserts the stacked facepile renders a capped avatar stack + "+N" overflow chip, encodes each
// peer's sync state as a ring colour (synced / syncing-pulse / paused — never opacity), shows the
// heading, exposes an accessible name listing the mirrors and their states, and carries no
// explanatory body copy — a sidebar tile states, it does not explain. It also measures that the
// "Show all" toggle is flush with the card's right content edge (as in the Members tile) instead of
// stacked in the eyebrow column.
//
//   node test/frontend-layout/run-mirrorers.mjs            (builds, then runs)
//   node test/frontend-layout/run-mirrorers.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-mirrorers.html', height: 260 })

console.log('\n──────── People tile harness ────────')
console.log(`heading      : "${out.heading}" · aria-expanded=${out.headerExpanded} (true) · count="${out.headerCount}" (6 = owner + 5 other mirrors)`)
console.log(`aria-label   : "${out.ariaLabel}"`)
console.log(`avatar stack : ${out.avatarCount} (5) · overflow: "${out.overflowText}" (+1)`)
console.log(`rings        : synced=${out.hasSyncedRing} syncing-pulse=${out.hasSyncingPulse} paused=${out.hasPausedRing} (all true) · opacity used=${out.hasOpacity} (false)`)
console.log(`body copy    : ${out.hasBodyCopy} (false — the tile states, it does not explain)`)
console.log(`toggle       : ${out.toggleRightGap?.toFixed(2)}px from the right content edge (0) · ${out.toggleIndent?.toFixed(2)}px right of the eyebrow column (>20)`)
if (out.error) console.log(`error        : ${out.error}`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} tile renders sync-state rings (no opacity), capped stack + overflow, heading + accessible name, no body copy, right-aligned toggle, foldable header`)
process.exit(pass ? 0 : 1)
