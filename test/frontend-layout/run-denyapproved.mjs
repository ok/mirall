// Deny-on-approved-member test (LOCAL/dev-machine only — spawns a real Electron GUI process).
// Mounts the real <SpaceScreen> with one pending request whose deny resolves already-approved,
// and asserts the control disables in flight and the outcome is a sticky polite status toast; a
// second deny that finds nothing open is reported politely too.
//
//   node test/frontend-layout/run-denyapproved.mjs            (builds, then runs)
//   node test/frontend-layout/run-denyapproved.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-denyapproved.html', height: 900 })

console.log('\n──────── SpaceScreen deny-on-approved-member harness ────────')
console.log(`initially enabled      : ${out.initiallyEnabled}`)
console.log(`disabled while denying : ${out.disabledWhileBusy}`)
console.log(`polite status toast    : ${out.politeStatus}`)
console.log(`not an alert           : ${out.notAlert}`)
console.log(`sticky past 5 s        : ${out.sticky}`)
console.log(`not-open polite toast  : ${out.notOpenPolite}`)
console.log(`approve already-in     : ${out.approvedPolite}`)
if (out.error) console.log(`error                  : ${out.error}`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} A deny on an already-approved member is reported in a sticky polite toast` +
  (pass ? '' : '  — the deny must disable in flight and its already-approved outcome must stay on screen as role=status'))
process.exit(pass ? 0 : 1)
