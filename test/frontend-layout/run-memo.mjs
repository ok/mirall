// REGRESSION (FIX-R04-7 / FIX-R03-9: with zero memoized rows, useDecorations' 1 Hz heartbeat
// re-rendered every row in the list once a second for as long as a transfer was live) — LOCAL/
// dev-machine only, spawns a real Electron GUI process. Mounts real <ShareFileRow>s and counts
// renders across an idle heartbeat tick, a single-row summary change, and a listing refetch.
//
//   node test/frontend-layout/run-memo.mjs            (builds, then runs)
//   node test/frontend-layout/run-memo.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-memo.html', height: 700 })

const counts = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ')

console.log('\n──────── ShareFileRow render-count harness ────────')
console.log(`real export is memo()      : ${out.isMemo}`)
console.log(`mount                      : ${counts(out.mountCounts)} (each must be 1)`)
console.log(`+ idle heartbeat tick      : ${counts(out.afterIdleTick)} (must be unchanged)`)
console.log(`+ b.txt summary change     : ${counts(out.afterOneSummary)} (only b.txt may move)`)
console.log(`+ unchanged full refetch   : ${counts(out.afterUnchangedRefetch)} (must be unchanged)`)
console.log(`+ c.txt content change     : ${counts(out.afterOneRowChanged)} (only c.txt may move)`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} only the rows that actually changed re-render`)
process.exit(pass ? 0 : 1)
