// REGRESSION (dialog error association): a field that reports a validation error must mark itself
// invalid and describe itself with that error's text — LOCAL/dev-machine only (spawns a real
// Electron GUI process, like the agent-desktop frontend suite). The macOS AX tree carries neither
// attribute, so this is the only layer that can assert them.
//
//   node test/frontend-layout/run-errorassoc.mjs            (builds, then runs)
//   node test/frontend-layout/run-errorassoc.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-errorassoc.html', width: 900, height: 900 })

const line = (label, probe) =>
  `${label.padEnd(12)}: ${probe.found ? '' : 'NOT FOUND '}invalid ${probe.invalid} · described "${probe.describedBy}"`

console.log('\n──────── Dialog error-association harness ────────')
console.log(line('space name', out.spaceName))
console.log(line('space path', out.spaceFolder))
console.log(line('folder name', out.folderName))
console.log(line('folder path', out.folderPath))
console.log(line('mirror name', out.mirrorName))
console.log(line('mount path', out.mountPath))
if (out.error) console.log(`error: ${out.error}`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} every dialog field reports invalid and resolves to its own error text`)
process.exit(pass ? 0 : 1)
