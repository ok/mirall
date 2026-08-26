import test from 'brittle'
import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'

const dir = fileURLToPath(new URL('../../src/renderer/screens', import.meta.url))
const read = (f) => readFileSync(`${dir}/${f}`, 'utf8')
const screens = readdirSync(dir).filter((f) => f.endsWith('.tsx'))

// Every settings-style screen scrolls its own body in a full-height container
// (`h-[calc(100vh-…)] overflow-y-auto`) while the window itself never scrolls.
// That only holds if the container also establishes a containing block.
//
// `sr-only` is `position: absolute` (Tailwind's clip-based visually-hidden
// recipe), and CopyButton renders one as its "Copied" live region. With no
// positioned ancestor between it and <body>, an absolutely positioned element
// resolves against the INITIAL containing block, so its static position deep
// inside the scrolled content extends the DOCUMENT's scrollable area — the
// window grows a second scrollbar beside the inner one, most visibly on
// Network status once "Show advanced details" expands. `relative` on the
// scroller keeps the live region inside the box that already scrolls.
//
// The other absolutely positioned descendants of these screens (the search
// icon in ActivityLog, the toggle knob in ActivityLogSettings, the avatar
// hover overlay in Account) all sit under their own `relative` parent, and
// modals position against Modal's `fixed inset-0`, so none of them change
// containing block here.
const isScroller = (line) => line.includes('h-[calc(100vh-') && line.includes('overflow-y-auto')

test('REGRESSION (FIX-1): full-height screen scrollers establish a containing block', (t) => {
  let checked = 0
  for (const file of screens) {
    const src = read(file)
    if (!src.includes('h-[calc(100vh-')) continue
    const lines = src.split('\n').filter(isScroller)
    // A screen that has the height but no matching scroller line either uses a
    // flex-column wrapper (SpaceView, FolderView, SharedSpaces) or wrapped its
    // className across lines, which this matcher would silently skip.
    if (lines.length === 0) {
      t.absent(/overflow-y-auto[\s\S]{0,200}h-\[calc\(100vh-|h-\[calc\(100vh-[\s\S]{0,200}overflow-y-auto/.test(src),
        `${file}: full-height scroller className stays on one line`)
      continue
    }
    for (const line of lines) {
      checked++
      t.ok(/\brelative\b/.test(line), `${file}: full-height scroller is relative`)
    }
  }
  t.ok(checked >= 11, `checked ${checked} full-height screen scrollers`)
})
