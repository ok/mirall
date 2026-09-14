// REGRESSION (issue #248: retry error toasts stacked) — LOCAL/dev only, spawns a real Electron
// GUI process. Says one sentence three times through the real <ToastProvider> and asserts one
// banner remains, that the repeat remounts it (fresh countdown, re-announced alert), and that a
// different sentence still stacks.
//
//   node test/frontend-layout/run-toastdedupe.mjs            (builds, then runs)
//   node test/frontend-layout/run-toastdedupe.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-toastdedupe.html', height: 600 })

console.log('\n──────── retry-toast dedupe harness ────────')
console.log(`toasts after 3 retries : ${out.afterThreeRetries} (must be 1)`)
console.log(`repeat remounted       : ${out.remounted} (must be true — fresh countdown + alert node)`)
console.log(`ring offset before     : ${out.ringBeforeRetry.toFixed(2)}`)
console.log(`ring offset after      : ${out.ringAfterRetry.toFixed(2)} (must be larger — countdown restarted)`)
console.log(`toasts after a 2nd text: ${out.afterOtherMessage} (must be 2 — only identical text collapses)`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} a retried failure collapses into one re-popped toast`)
process.exit(pass ? 0 : 1)
