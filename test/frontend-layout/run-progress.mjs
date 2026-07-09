// Progress-lane ARIA test (LOCAL/dev-machine only — spawns a real Electron GUI
// process, like the agent-desktop frontend suite). Mounts the real
// <DownloadProgressLane> in real Chromium and asserts the indeterminate (ETA
// warmup) state drops aria-valuenow + runs the sweep while the determinate state
// exposes aria-valuenow, plus that resolveEta resolves to real i18n strings and
// hides a stale ETA on a stall.
//
//   node test/frontend-layout/run-progress.mjs            (builds, then runs)
//   node test/frontend-layout/run-progress.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-progress.html', height: 300 })

console.log('\n──────── DownloadProgressLane ARIA harness ────────')
console.log(`indeterminate: no aria-valuenow = ${out.indNoValueNow}, sweep = ${out.indHasSweep}, valuetext = "${out.indValueText}"`)
console.log(`determinate  : aria-valuenow = ${out.detValueNow}, sweep = ${out.detHasSweep}, valuetext = "${out.detValueText}"`)
console.log(`verifying    : aria-valuenow = ${out.verValueNow}, visible meta = "${out.verMetaText}"`)
console.log(`resolveEta   : null="${out.mapNull}"  0="${out.mapZero}"  undefined="${out.mapUndefined}"  >0="${out.mapPositive}"  stalled="${out.mapStalled}"  live="${out.mapLive}"`)
console.log(`etaFromRate  : complete="${out.rateComplete}"  idle="${out.rateIdle}"  live="${out.rateLive}"`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} progress lane exposes the correct ARIA state per mode and resolveEta resolves real strings (hiding a stalled ETA)`)
process.exit(pass ? 0 : 1)
