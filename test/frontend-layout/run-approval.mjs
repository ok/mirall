// Join-request in-flight affordance test (LOCAL/dev-machine only — spawns a real Electron GUI
// process, like the agent-desktop frontend suite). Mounts the real <SpaceView> with one pending
// request, clicks Approve, and asserts the button disables in-flight while the derived request
// row is never hidden, then re-enables once the (delayed) call settles.
//
//   node test/frontend-layout/run-approval.mjs            (builds, then runs)
//   node test/frontend-layout/run-approval.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-approval.html', height: 900 })

console.log('\n──────── SpaceView approval in-flight harness ────────')
console.log(`initially enabled        : ${out.initiallyEnabled}`)
console.log(`disabled while approving : ${out.disabledWhileBusy}`)
console.log(`request row persists     : ${out.rowPersists}`)
console.log(`re-enabled after settle  : ${out.reenabledAfter}`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} Approve control disables in-flight and the derived request row is never hidden` +
  (pass ? '' : '  — the button must disable while the RPC is outstanding and the row must stay until a hint removes it'))
process.exit(pass ? 0 : 1)
