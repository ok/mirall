// Waiting-cluster layout test (LOCAL/dev-machine only — spawns a real Electron GUI process).
// Mounts the real <FileCard> mid-hash with members waiting at three row widths and asserts the
// cluster yields before the hash bar: no overflow, the bar keeps its width, the toggle stays in the
// card, and only the narrow row sheds the avatar stack.
//
//   node test/frontend-layout/run-waiting.mjs            (builds, then runs)
//   node test/frontend-layout/run-waiting.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-waiting.html', height: 700, width: 1000 })

console.log('\n──────── Owner row with members waiting ────────')
if (out.error) console.log(`error: ${out.error}`)
for (const [id, m] of Object.entries(out.rows ?? {})) {
  console.log(`${id.padEnd(7)}: overflow ${m.overflow}, bar ${Math.round(m.barWidth)}px, toggle visible ${m.toggleVisible} inside ${m.toggleInside}, stack ${m.stackVisible}`)
}

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} the waiting cluster yields width before the hash bar and never overflows the row`)
process.exit(pass ? 0 : 1)
