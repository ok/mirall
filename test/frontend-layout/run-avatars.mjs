// Avatar recess coverage (LOCAL/dev only — spawns a real Electron GUI process). Mounts the primitive
// in all nine shapes plus the real hosts that draw an avatar differently — member row, top bar,
// Activity Log actor disc, first-run picker — and sweeps the tree for a round, avatar-sized disc
// that is NOT recessed, which is how a screen nobody thought of shows up.
//
//   node test/frontend-layout/run-avatars.mjs            (builds, then runs)
//   node test/frontend-layout/run-avatars.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-avatars.html', height: 1100 })

console.log('\n──────── avatar recess harness ────────')
console.log(`avatar discs found : ${out.discsSeen}`)
console.log(`recessed           : ${out.recessed}/${out.discsSeen}`)
console.log(`recess shadow      : ${out.recessShadow}`)
console.log(`presence dot       : ${out.dotOffsetX?.toFixed(2)}px / ${out.dotOffsetY?.toFixed(2)}px from the disc's corner `
  + `(${out.dotOnCorner ? 'still on the corner' : 'MOVED — the image wrapper changed the box'})`)
for (const p of out.probes ?? []) {
  console.log(`  ${p.where.padEnd(19)}: ${!p.found ? 'NOT FOUND — the probe needs re-pointing' : (p.recessed ? 'recessed' : 'BARE')}`)
}
for (const m of out.misses ?? []) console.log(`      NOT recessed: [${m.where}] ${m.size} — ${m.classes}`)
if (out.error) console.log(`error              : ${out.error}`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} every avatar-shaped disc in the app is recessed, and the presence dot still sits on its corner`)
process.exit(pass ? 0 : 1)
