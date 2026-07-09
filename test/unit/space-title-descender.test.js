import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'

const root = new URL('../../', import.meta.url)
const read = (p) => readFileSync(fileURLToPath(new URL(p, root)), 'utf8')

const SPACEVIEW = 'src/renderer/screens/SpaceView.tsx'
const FOLDERVIEW = 'src/renderer/screens/FolderView.tsx'
const SPACECARD = 'src/renderer/components/cards/SpaceCard.tsx'
const CREATESPACE = 'src/renderer/components/modals/CreateSpaceModal.tsx'

// The 800/700-weight headline font (Plus Jakarta Sans) has descenders/tails
// (e.g. the "Q" in "DigitalHQ", the "g" in "large files") that overflow a tight
// line box. Paired with `truncate` (overflow:hidden, which clips at the padding
// edge) those glyphs get cropped at the bottom. Two mitigations, applied by size:
//
//   * `pb-*` adds clip headroom below the baseline — needed at EVERY size, since
//     with zero bottom padding the clip edge sits flush at the content box.
//   * `leading-tight` (1.25) only helps text-4xl, whose default line-height ratio
//     (2.5/2.25 ≈ 1.11) is tighter than 1.25 and so clips. It must NOT be added to
//     text-xl titles, whose default ratio (1.75/1.25 = 1.4) is already looser —
//     forcing 1.25 there would SHRINK the line box and reintroduce clipping.
const titleClass = (src, size) => {
  const re = new RegExp(`<h[13] className="([^"]*\\b${size}\\b[^"]*\\bfont-headline\\b[^"]*)"`)
  return src.match(re)?.[1] ?? null
}

test('REGRESSION (FIX-1): text-4xl space/folder titles get leading-tight + pb headroom', (t) => {
  for (const [name, path] of [['SpaceView', SPACEVIEW], ['FolderView', FOLDERVIEW]]) {
    const cls = titleClass(read(path), 'text-4xl')
    t.ok(cls, `${name} has a text-4xl font-headline title`)
    t.ok(cls.includes('truncate'), `${name} title still truncates long names`)
    t.ok(cls.includes('leading-tight'), `${name} title loosens the tight text-4xl line box`)
    t.ok(/\bpb-\d/.test(cls), `${name} title has bottom padding for clip headroom`)
  }
})

test('REGRESSION (FIX-2): text-xl headline titles get pb headroom without leading-tight', (t) => {
  for (const [name, path] of [['SpaceCard', SPACECARD], ['CreateSpaceModal', CREATESPACE]]) {
    const cls = titleClass(read(path), 'text-xl')
    t.ok(cls, `${name} has a text-xl font-headline title`)
    t.ok(cls.includes('truncate'), `${name} title still truncates long names`)
    t.ok(/\bpb-[\d.]/.test(cls), `${name} title has bottom padding for clip headroom`)
    t.absent(cls.includes('leading-tight'), `${name} title keeps the looser text-xl line box (no leading-tight)`)
  }
})
