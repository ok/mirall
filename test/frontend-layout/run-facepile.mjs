// REGRESSION (FIX-RIM: the facepile grows a dark rim when its card lifts) — LOCAL/dev only, spawns
// a real Electron GUI process. Mounts the real <SpaceCard> and asserts, in both themes and in both
// states, that each avatar's ring carries the fill of the card behind it and that the +N chip still
// reads against that card.
//
//   node test/frontend-layout/run-facepile.mjs            (builds, then runs)
//   node test/frontend-layout/run-facepile.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-facepile.html', height: 240 })

console.log('\n──────── facepile ring harness ────────')
console.log(`stylesheets read     : ${out.sheetsRead}`)
console.log(`:hover rules scanned : ${out.hoverRulesSeen}`)
console.log(`faces measured       : ${out.avatarCount} (the fake bridge's roster, capped at 3)`)
for (const t of out.themes ?? []) {
  for (const [state, m] of [['rest ', t.rest], ['hover', t.hover]]) {
    console.log(`${t.theme.padEnd(5)} ${state} : card ${m.cardBg} · ring ${[...new Set(m.ringColors)].join(', ')} `
      + `(${m.ringMatchesCard ? 'cut from the card' : 'VISIBLE RIM'}) · +N ${m.chipBg} `
      + `(${m.chipReadsAgainstCard ? 'reads' : 'INVISIBLE'}) · initials ${m.faceBg} `
      + `(${m.faceReadsAgainstCard ? 'reads' : 'INVISIBLE'})`)
  }
}
for (const t of out.themes ?? []) {
  console.log(`${t.theme.padEnd(5)} recess: ${t.recessShadow} (${t.recessed ? 'every face and the +N disc' : 'MISSING on at least one disc'})`)
}
const tm = out.timing
if (tm) {
  console.log(`card fade    : ${tm.cardProperty} ${tm.cardDuration} ${tm.cardTiming}`)
  console.log(`ring fade    : ${tm.ringProperty} ${tm.ringDuration} ${tm.ringTiming}`
    + ` (${tm.inStep ? 'in step with the card' : (tm.ringDuration === '0s' ? 'SNAPS — box-shadow not transitioned' : 'OUT OF STEP')})`)
}
if (out.error) console.log(`error        : ${out.error}`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} every ring carries the card's own fill — in step with it — every disc is recessed, and the +N disc stays visible, at rest and under the cursor, in both themes`)
process.exit(pass ? 0 : 1)
