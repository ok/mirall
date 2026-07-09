// Layout regression test (LOCAL/dev-machine only — spawns a real Electron GUI
// process, like the agent-desktop frontend suite). Reproduces the mirror
// download re-render storm in real Chromium and asserts the DOCUMENT never
// overflows the viewport (no OS-level scrollbar). Prints the offending elements
// so a failure is self-diagnosing.
//
//   node test/frontend-layout/run.mjs            (builds, then runs)
//   node test/frontend-layout/run.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness.html' })

const fmt = (list) => (list || []).map((o) => {
  const flag = o.pos === 'fixed' ? '[fixed]' : o.clipped ? '[clipped]' : '[FLOW] '
  return `      ${flag} <${o.tag} class="${o.cls}">  top=${o.top} bottom=${o.bottom} h=${o.height}`
}).join('\n')

console.log('\n──────── FolderView document-overflow harness ────────')
console.log(`innerHeight            : ${out.innerHeight}px`)
console.log(`baseline overflow      : ${out.baselineOverflow}px (before any download activity)`)
console.log(`frames sampled         : ${out.frames}`)
console.log(`frames with overflow   : ${out.overflowFrames}`)
console.log(`frames document-scrollable : ${out.scrollableFrames}  (ever scrollable: ${out.everScrollable})`)
console.log(`MAX document overflow  : ${out.maxOverflow}px  (scrollHeight peaked at ${out.lastScrollHeight}px)`)
if (out.maxOverflow > 0) {
  const m = out.worstMetrics || {}
  console.log('container metrics at worst frame:')
  console.log(`      html      scrollH=${m.html?.scrollH} clientH=${m.html?.clientH}`)
  for (const key of ['body', 'root', 'main', 'screen']) {
    const c = m[key]
    if (c) console.log(`      ${key.padEnd(9)} top=${c.top} bottom=${c.bottom} h=${c.height} scrollH=${c.scrollH} clientH=${c.clientH} overflowY=${c.overflowY} pt=${c.pt}`)
  }
  console.log('body direct children:')
  for (const c of out.worstBodyChildren || []) console.log(`      <${c.tag} class="${c.cls}"> top=${c.top} bottom=${c.bottom} h=${c.height}`)
  console.log('positioned (absolute/fixed/sticky) elements:')
  for (const p of out.worstPositioned || []) {
    console.log(`      [${p.pos}] <${p.tag} class="${p.cls}"> (in ${p.parent})  rect top=${p.top} bottom=${p.bottom} h=${p.height}  css{top:${p.cssTop} bottom:${p.cssBottom} height:${p.cssHeight}}`)
  }
  console.log('elements escaping the viewport ([FLOW]=real document-overflow contributor):')
  console.log(fmt(out.worstOffenders) || '      (none captured)')
}

// The app is a fixed-viewport shell: the document must NEVER become scrollable
// (no OS-level scrollbar over empty space). That's the user-visible symptom and
// what the fix must eliminate.
const pass = out.everScrollable === false
console.log(`\n${pass ? 'ok  ' : 'FAIL'} document never becomes scrollable during the download storm` +
  (pass ? '' : `  (scrollable on ${out.scrollableFrames}/${out.frames} frames — OS scrollbar appears over empty space)`))
process.exit(pass ? 0 : 1)
