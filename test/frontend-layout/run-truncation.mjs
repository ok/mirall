// Text-truncation test (LOCAL/dev-machine only — spawns a real Electron GUI process, like the
// agent-desktop frontend suite). Mounts the real <PathRow> and <FileName> in a narrow field and
// asserts neither escapes it, and that each keeps its distinguishing ending — a long path bleeding
// over the Browse button beside it is what this exists to catch.
//
//   node test/frontend-layout/run-truncation.mjs            (builds, then runs)
//   node test/frontend-layout/run-truncation.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-truncation.html', width: 600, height: 300 })

console.log('\n──────── Text truncation harness ────────')
console.log(`path : overflow ${out.pathOverflow}px (<= 0) · ellipsised ${out.pathEllipsised} · ends "${out.pathEndsWith}"`)
console.log(`name : overflow ${out.nameOverflow}px (<= 0) · ends "${out.nameEndsWith}"`)
if (out.error) console.log(`error: ${out.error}`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} long paths and filenames stay inside their field and keep their ending`)
process.exit(pass ? 0 : 1)
