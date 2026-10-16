// REGRESSION (FIX-R04-7 / FIX-R03-9: with zero memoized rows, useDecorations' 1 Hz heartbeat
// re-rendered every row in the list once a second for as long as a transfer was live) — LOCAL/
// dev-machine only, spawns a real Electron GUI process. Mounts real folder <FileRow>s and counts
// renders across an idle heartbeat tick, a single-row summary change, a listing refetch, and a
// transfer frame — plus the file-tree rebuilds that frame must not cause — across another
// space's download folder changing (no row moves) and this space's (every row moves), and across
// settings and folder reachability answered again with the same values (no row moves:
// REGRESSION (FIX-DLTO-R28)).
//
//   node test/frontend-layout/run-memo.mjs            (builds, then runs)
//   node test/frontend-layout/run-memo.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-memo.html', height: 700 })

const counts = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ')

console.log('\n──────── FileRow render-count harness ────────')
console.log(`real export is memo()      : ${out.isMemo} (its comparator bails only on identical props)`)
console.log(`mount                      : ${counts(out.mountCounts)} (each must be 1)`)
console.log(`+ idle heartbeat tick      : ${counts(out.afterIdleTick)} (must be unchanged)`)
console.log(`+ b.txt summary change     : ${counts(out.afterOneSummary)} (only b.txt may move)`)
console.log(`+ unchanged full refetch   : ${counts(out.afterUnchangedRefetch)} (must be unchanged)`)
console.log(`+ c.txt content change     : ${counts(out.afterOneRowChanged)} (only c.txt may move)`)
console.log(`+ a.txt transfer frame     : ${counts(out.afterOneDecoration)} (only a.txt may move)`)
console.log(`file-tree rebuilds         : ${out.treeBuildsBeforeDecoration} -> ${out.treeBuildsAfterDecoration} across that frame (must not move)`)
console.log(`+ other space's folder     : ${counts(out.afterOtherSpaceFolder ?? {})} (must be unchanged)`)
console.log(`+ this space's folder      : ${counts(out.afterOwnSpaceFolder ?? {})} (every row must move)`)
console.log(`+ same settings again      : ${counts(out.afterEqualSettings ?? {})} (must be unchanged)`)
console.log(`+ same reachability again  : ${counts(out.afterEqualRoots ?? {})} (must be unchanged)`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} only the rows that actually changed re-render`)
process.exit(pass ? 0 : 1)
