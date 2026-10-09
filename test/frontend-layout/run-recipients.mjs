// Recipients-cluster layout test (LOCAL/dev-machine only — spawns a real Electron GUI process).
// Mounts the real <FileCard> and <ShareFileRow> with two of three members holding the file at four
// row widths and asserts the cluster sheds before the name: no overflow, a one-line toggle, faces
// only when wide, "2/3" when narrow, and the name keeps its width; an open list closes when a
// publish takes the lane.
//
//   node test/frontend-layout/run-recipients.mjs            (builds, then runs)
//   node test/frontend-layout/run-recipients.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-recipients.html', height: 1100, width: 1000 })

console.log('\n──────── Owner row with recipients ────────')
if (out.error) console.log(`error: ${out.error}`)
for (const [id, m] of Object.entries(out.rows ?? {})) {
  console.log(`${id.padEnd(14)}: overflow ${m.overflow}, toggle ${Math.round(m.toggleHeight)}px inside ${m.toggleInside}, faces ${m.facesVisible}, full ${m.fullVisible}, short ${m.shortVisible}, name ${Math.round(m.nameWidth)}px`)
}

if (out.orphan) console.log(`orphan        : opened ${out.orphan.opened}, still open once publishing ${out.orphan.orphaned}`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} the recipients cluster sheds before the file name and never wraps or overflows`)
process.exit(pass ? 0 : 1)
