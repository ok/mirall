// Which listing re-reads on which reconcile hint — LOCAL/dev-machine only, spawns a real Electron
// GUI process. Mounts the loose list, two folder listings and the space total under the real query
// store, pushes one hint per kind and counts the requests each view issues.
//
//   npm run test:layout:case -- pokescope            (builds, then runs)
//   npm run test:layout:case -- pokescope --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-pokescope.html', height: 300 })

const counts = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ')

console.log('\n──────── listing poke-scope harness ────────')
console.log(`cold reads                 : ${counts(out.cold)} (each must be 1)`)
for (const s of out.steps) {
  console.log(`${s.ok ? 'ok  ' : 'FAIL'} hint ${JSON.stringify(s.hint)}`)
  console.log(`       moved    ${counts(s.delta)}`)
  if (!s.ok) console.log(`       expected ${counts(s.expected)}`)
}

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} each hint re-reads exactly the listings it names`)
process.exit(pass ? 0 : 1)
