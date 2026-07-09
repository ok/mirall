// REGRESSION (FIX: Remove/Leave/Mirror/Delete confirm-modal titles) — LOCAL/dev
// only, spawns a real Electron GUI process. Mounts real <RemoveFileModal>s and
// asserts a pathological name (1) never overflows/clips the fixed-width panel,
// (2) keeps the close button square, (3) middle-truncates keeping both ends +
// the extension, (4) stays within two lines, while a short name renders in full
// and the untruncated name stays in the accessible title.
//
//   node test/frontend-layout/run-modaltitle.mjs            (builds, then runs)
//   node test/frontend-layout/run-modaltitle.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-modaltitle.html', height: 700 })

console.log('\n──────── confirm-modal title harness ────────')
console.log(`long panel width    : ${out.longPanelWidth}px`)
console.log(`long panel scrollW  : ${out.longPanelScrollWidth}px (must be <= width — no clip)`)
console.log(`long title inside   : ${out.longTitleInside}`)
console.log(`long name in a11y   : ${out.longNameAccessible}`)
console.log(`close button size   : ${out.longCloseWidth}×${out.longCloseHeight}px (must be ~40×40, square)`)
console.log(`long fitted name    : "${out.longFitName}" (middle-truncated, must keep '…' and end '.mov')`)
console.log(`long title height   : ${out.longTitleHeight}px / line ${out.longLineHeight}px (must be <= 2 lines)`)
console.log(`short panel scrollW : ${out.shortPanelScrollWidth}px / width ${out.shortPanelWidth}px`)
console.log(`short fitted name   : "${out.shortFitName}" (must be the full name, no '…')`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} long titles middle-truncate within 2 lines without clipping; short titles stay intact`)
process.exit(pass ? 0 : 1)
