// ActionMenu single-choice test (LOCAL/dev-machine only — spawns a real Electron GUI process).
// Mounts the real <ActionMenu> as the Download-to menu beside a More menu and a filter menu, and
// asserts radio items with one checked while Choose Folder… stays a plain menu item
// (REGRESSION (FIX-DLTO-R15: Choose Folder… read as an unchecked radio item)), a heading that never
// takes focus, descriptions wired to aria-describedby, ArrowDown skipping a disabled item, Esc
// returning focus to the trigger, and the existing menus unchanged.
//
//   node test/frontend-layout/run-actionmenu.mjs            (builds, then runs)
//   node test/frontend-layout/run-actionmenu.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-actionmenu.html', width: 900, height: 600 })

console.log('\n──────── ActionMenu single-choice harness ────────')
const c = out.choice
if (c) {
  console.log(`roles        : ${c.roles.join(', ')} (Choose Folder… must be a plain menuitem)`)
  console.log(`aria-checked : ${JSON.stringify(c.checkedAttrs)}`)
  console.log(`checked      : ${JSON.stringify(c.checked)}`)
  console.log(`heading      : "${c.headingText}" · ${c.headingFocusable ? 'TAKES FOCUS' : 'not focusable'}`)
  console.log(`descriptions : ${JSON.stringify(c.descriptions)}`)
  console.log(`long path    : menu ${c.menuWidth}px (cap 352) · ${c.longPathTruncated ? 'truncated' : 'NOT TRUNCATED'} · icons [${c.iconWidths}]px`)
  console.log(`ArrowDown    : ${c.focusAfterOpen} → ${c.focusAfterDown}`)
  console.log(`Esc          : ${c.closedOnEsc ? 'closed' : 'STILL OPEN'} · focus ${c.focusOnTrigger ? 'on the trigger' : 'LOST'}`)
}
for (const l of out.legacy ?? []) {
  console.log(`${l.id.padEnd(13)}: ${l.opened ? 'opened' : 'NEVER OPENED'} · roles ${l.roles.join(', ')} · checked ${l.anyChecked} · described ${l.anyDescribed} · heading ${l.heading} · min-w ${l.popupMinWidth} · heights [${l.itemHeights}]`)
  if (l.triggerClass !== l.expectedTriggerClass) console.log(`  TRIGGER    : "${l.triggerClass}"\n  expected   : "${l.expectedTriggerClass}"`)
}
if (out.error) console.log(`error        : ${out.error}`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} a single-choice menu reads as radio items with one checked; the existing menus are unchanged`)
process.exit(pass ? 0 : 1)
