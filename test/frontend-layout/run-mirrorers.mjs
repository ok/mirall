// People sidebar tile test (LOCAL/dev-machine only — spawns a real Electron GUI process,
// like the agent-desktop frontend suite). Mounts the real <FolderPeopleCard> in real Chromium and
// asserts the stacked facepile renders a capped avatar stack + "+N" overflow chip, encodes each
// peer's sync state as a ring colour (synced / syncing-pulse / paused — never opacity), shows the
// heading, exposes an accessible name listing the mirrors and their states, and carries no
// explanatory body copy — a sidebar tile states, it does not explain.
//
//   node test/frontend-layout/run-mirrorers.mjs            (builds, then runs)
//   node test/frontend-layout/run-mirrorers.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-mirrorers.html', height: 260 })

console.log('\n──────── People tile harness ────────')
console.log(`heading      : "${out.heading}"`)
console.log(`aria-label   : "${out.ariaLabel}"`)
console.log(`avatar stack : ${out.avatarCount} (5) · overflow: "${out.overflowText}" (+1)`)
console.log(`rings        : synced=${out.hasSyncedRing} syncing-pulse=${out.hasSyncingPulse} paused=${out.hasPausedRing} (all true) · opacity used=${out.hasOpacity} (false)`)
console.log(`body copy    : ${out.hasBodyCopy} (false — the tile states, it does not explain)`)
if (out.error) console.log(`error        : ${out.error}`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} tile renders sync-state rings (no opacity), capped stack + overflow, heading + accessible name, no body copy`)
process.exit(pass ? 0 : 1)
