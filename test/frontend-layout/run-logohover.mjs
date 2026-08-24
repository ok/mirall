// REGRESSION (FIX-366: top bar logo greys out on hover) — LOCAL/dev only, spawns
// a real Electron GUI process. Mounts the real <TopNav> and asserts no :hover
// rule in the real stylesheet repaints the logo (opacity/color/fill/filter).
// The press feedback (`active:scale-95`) is untouched — it moves the logo
// rather than recolouring it.
//
//   node test/frontend-layout/run-logohover.mjs            (builds, then runs)
//   node test/frontend-layout/run-logohover.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-logohover.html', height: 200 })

console.log('\n──────── top bar logo hover harness ────────')
console.log(`stylesheets read     : ${out.sheetsRead}`)
console.log(`:hover rules scanned : ${out.hoverRulesSeen}`)
console.log(`logo button classes  : ${out.buttonClasses}`)
console.log(`repainting on hover  : ${out.hits.length}`)
for (const h of out.hits) console.log(`      ${h.selector} { ${h.property}: ${h.value} }`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} hovering the top bar logo changes nothing about how it is painted`)
process.exit(pass ? 0 : 1)
