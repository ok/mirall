// Space-screen document-overflow test (LOCAL/dev-machine only — spawns a real Electron GUI
// process, like the agent-desktop frontend suite). Mounts the real <SpaceView> with a list long
// enough to scroll and asserts the DOCUMENT never becomes scrollable — an OS scrollbar over the
// whole window means a box escaped the pane that was supposed to clip it. Prints the offending
// elements so a failure is self-diagnosing.
//
//   node test/frontend-layout/run-spaceoverflow.mjs            (builds, then runs)
//   node test/frontend-layout/run-spaceoverflow.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-spaceoverflow.html' })

const fmt = (list) => (list || []).map((o) => {
  const flag = o.pos === 'fixed' ? '[fixed]' : o.clipped ? '[clipped]' : '[FLOW] '
  return `      ${flag} <${o.tag} class="${o.cls}">  top=${o.top} bottom=${o.bottom} h=${o.height}`
}).join('\n')

const fmtPhase = (label, p) => p
  ? `      ${label}: documentOverflow=${p.overflow}px scrollable=${p.scrollable} (pane scrollTop=${p.paneScrollTop})`
  : `      ${label}: (not measured)`

console.log('\n──────── SpaceView document-overflow harness ────────')
console.log(`innerHeight            : ${out.innerHeight}px`)
console.log(`share cards rendered   : ${out.shareCards}`)
console.log(`list pane scrolls      : ${out.paneScrolls}`)
console.log('measurements:')
console.log(fmtPhase('at rest ', out.rest))
console.log(fmtPhase('scrolled', out.scrolled))
if (out.error) console.log(`error                  : ${out.error}`)

if (!out.pass) {
  const m = out.worstMetrics || {}
  console.log('container metrics:')
  console.log(`      html      scrollH=${m.html?.scrollH} clientH=${m.html?.clientH}`)
  for (const key of ['body', 'root', 'main', 'screen']) {
    const c = m[key]
    if (c) console.log(`      ${key.padEnd(9)} top=${c.top} bottom=${c.bottom} h=${c.height} scrollH=${c.scrollH} clientH=${c.clientH} overflowY=${c.overflowY} pt=${c.pt}`)
  }
  console.log('body direct children:')
  for (const c of out.worstBodyChildren || []) console.log(`      <${c.tag} class="${c.cls}"> top=${c.top} bottom=${c.bottom} h=${c.height}`)
  console.log('positioned (absolute/fixed/sticky) elements below the fold:')
  for (const q of (out.worstPositioned || []).filter((x) => x.bottom > out.innerHeight)) {
    console.log(`      [${q.pos}] <${q.tag} class="${q.cls}"> (in ${q.parent}) top=${q.top} bottom=${q.bottom} h=${q.height}`)
  }
  console.log('list pane, and every ancestor above it:')
  for (const c of out.chain || []) console.log(`      <${c.tag} class="${c.cls}"> top=${c.top} bottom=${c.bottom} h=${c.height} scrollH=${c.scrollH} clientH=${c.clientH} overflowY=${c.overflowY} pos=${c.position}`)
  console.log('elements escaping the viewport ([FLOW]=real document-overflow contributor):')
  console.log(fmt(out.worstOffenders) || '      (none captured)')
}

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} the space screen keeps its scrolling inside the list pane` +
  (pass ? '' : '  — the document itself scrolls, so an OS scrollbar appears over the window'))
process.exit(pass ? 0 : 1)
