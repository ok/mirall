// REGRESSION (FIX-447: one alert per file of a failing folder download) — LOCAL/dev only, spawns a
// real Electron GUI process. Emits a burst of per-file transfer errors through the real toast
// bridge and notification dispatcher and asserts one toast mounted once, and one OS notification
// re-shown once under the same id with the file count.
//
//   node test/frontend-layout/run-transferfaults.mjs            (builds, then runs)
//   node test/frontend-layout/run-transferfaults.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-transferfaults.html', height: 600 })

console.log('\n──────── transfer-fault burst harness ────────')
console.log(`toasts after the burst : ${out.toastsAfterBurst} (must be 1)`)
console.log(`toast mounts (burst)   : ${out.toastMounts} (must be 1 — a remount re-announces the alert)`)
for (const n of out.notifications) console.log(`notification           : ${n.id} — ${n.body}`)
console.log('                         (must be 2: the first file, then the count under the same id)')
console.log(`toasts after others    : ${out.toastsAfterOthers} (must be 3 — another fault or space is its own toast)`)
console.log(`toast mounts (others)  : ${out.otherMounts} (must be 2)`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} a burst of per-file faults is one toast and one notification`)
process.exit(pass ? 0 : 1)
