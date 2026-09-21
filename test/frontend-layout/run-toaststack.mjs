// REGRESSION (issue #373: a sticky toast was evicted by four newer ones) — LOCAL/dev only, spawns a
// real Electron GUI process. Raises a sticky toast then a burst through the real <ToastProvider> and
// asserts the sticky one and its action survive, the oldest auto-dismissing toast made room, and a
// stack of stickies grows rather than dropping one.
//
//   node test/frontend-layout/run-toaststack.mjs            (builds, then runs)
//   node test/frontend-layout/run-toaststack.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-toaststack.html', height: 900 })

console.log('\n──────── sticky-toast eviction harness ────────')
console.log(`toasts after the burst : ${out.afterBurst} (must be 4)`)
console.log(`sticky toast kept      : ${out.stickyKept} (must be true)`)
console.log(`its action kept        : ${out.actionKept} (must be true)`)
console.log(`sticky toast role      : ${out.stickyRole} (must be alert)`)
console.log(`oldest timed evicted   : ${out.oldestTimedEvicted} (must be true — and only it)`)
console.log(`toasts over 5 stickies : ${out.afterStickies} (must be 7 — stickies never evicted)`)
console.log(`newest notice kept     : ${out.newestKept} (must be true)`)
console.log(`overflow contained     : ${out.overflowContained} (must be true — scrolls inside the window)`)
console.log(`newest toast in view   : ${out.newestInView} (must be true)`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} a sticky toast outlives a burst of newer notices`)
process.exit(pass ? 0 : 1)
