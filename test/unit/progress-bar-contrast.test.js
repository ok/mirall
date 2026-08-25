import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'

const root = new URL('../../', import.meta.url)
const read = (p) => readFileSync(fileURLToPath(new URL(p, root)), 'utf8')

const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
const lum = (hex) => {
  const m = hex.replace('#', '')
  return 0.2126 * lin(parseInt(m.slice(0, 2), 16)) +
         0.7152 * lin(parseInt(m.slice(2, 4), 16)) +
         0.0722 * lin(parseInt(m.slice(4, 6), 16))
}
const contrast = (a, b) => {
  const la = lum(a), lb = lum(b), hi = Math.max(la, lb), lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

const css = read('src/renderer/styles/tailwind.css')
const tokensFor = (selector) => {
  const start = css.indexOf(selector + ' {')
  const block = css.slice(start, css.indexOf('}', start))
  const out = {}
  for (const m of block.matchAll(/--(color-[\w-]+):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]] = m[2]
  return out
}
const classBlock = (name) => {
  const start = css.indexOf('.' + name)
  return css.slice(start, css.indexOf('}', start))
}

const BARS = [
  'src/renderer/components/cards/PeerDownloadIndicator.tsx',
  'src/renderer/components/cards/PeerDownloadRow.tsx',
  'src/renderer/components/primitives/ProgressBar.tsx',
  'src/renderer/components/widgets/DownloadProgressLane.tsx',
  'src/renderer/components/modals/LeaveSpaceModal.tsx',
]

test('REGRESSION (FIX-1): on-info fill clears 3:1 vs track AND both hover lifts, both themes', (t) => {
  for (const theme of [':root', '.dark']) {
    const k = tokensFor(theme)
    const cTrack = contrast(k['color-on-info'], k['color-progress-track'])
    const cPill = contrast(k['color-on-info'], k['color-surface-container-high'])
    const cRow = contrast(k['color-on-info'], k['color-surface-container-highest'])
    t.ok(cTrack >= 3.0, `${theme}: on-info vs track = ${cTrack.toFixed(2)}:1`)
    t.ok(cPill >= 3.0, `${theme}: on-info vs hover pill = ${cPill.toFixed(2)}:1`)
    t.ok(cRow >= 3.0, `${theme}: on-info vs row hover lift = ${cRow.toFixed(2)}:1`)
  }
})

test('REGRESSION (FIX-2): hover-pill token is never a static progress bg', (t) => {
  const re = /bg-surface-container-high(?![a-z])/g
  for (const f of BARS) {
    const src = read(f)
    for (const m of src.matchAll(re)) {
      const before = src.slice(Math.max(0, m.index - 6), m.index)
      t.ok(before.endsWith('hover:'), `${f}: bg-surface-container-high must be hover-only (saw "${before}…")`)
    }
  }
})

test('REGRESSION (FIX-3): no progress bar uses bg-secondary-container; all use bg-on-info', (t) => {
  for (const f of BARS) {
    const src = read(f)
    t.absent(src.includes('bg-secondary-container'), `${f}: no secondary-container fill`)
    t.ok(src.includes('bg-on-info'), `${f}: uses on-info fill`)
  }
})

test('REGRESSION (FIX-4): indicator chevron is text-secondary, not text-outline', (t) => {
  const src = read('src/renderer/components/cards/PeerDownloadIndicator.tsx')
  t.absent(src.includes('text-outline'), 'no text-outline in the indicator')
  t.ok(/chevron_right[\s\S]{0,160}text-secondary/.test(src), 'chevron tinted text-secondary')
})

test('FIX-5: indeterminate sweep and leave stripe use --color-on-info', (t) => {
  const sweep = classBlock('progress-indeterminate')
  t.ok(sweep.includes('var(--color-on-info)'), 'sweep background is on-info')
  t.absent(sweep.includes('--color-secondary-container'), 'sweep no longer secondary-container')
  const stripe = classBlock('leave-progress-stripe')
  t.ok(stripe.includes('var(--color-on-info)'), 'leave stripe is on-info')
  t.absent(stripe.includes('--color-primary'), 'leave stripe no longer primary')
})

// Every surface a progress bar can rest on. Bars live inside file/folder rows that lift to
// `surface-container-highest` on hover, inside the peer-download toggle that lifts to
// `surface-container-high`, and inside modal panels (`surface-container-lowest`). A track
// painted in any of those tokens goes invisible the moment its host adopts the same one.
const HOST_SURFACES = [
  'color-surface-container-lowest',
  'color-surface-container-low',
  'color-surface-container',
  'color-surface-container-high',
  'color-surface-container-highest',
]

// 1.2:1 is the floor the resting file card already sits at, so it is the weakest
// separation the design is known to accept — not a WCAG number.
const TRACK_MIN = 1.2

test('REGRESSION (FIX-6): track token clears every host surface, both themes', (t) => {
  for (const theme of [':root', '.dark']) {
    const k = tokensFor(theme)
    t.ok(k['color-progress-track'], `${theme}: --color-progress-track is defined`)
    if (!k['color-progress-track']) continue
    for (const s of HOST_SURFACES) {
      const c = contrast(k['color-progress-track'], k[s])
      t.ok(c >= TRACK_MIN, `${theme}: track vs ${s} = ${c.toFixed(2)}:1`)
    }
  }
})

test('REGRESSION (FIX-6): every bar paints its track with the dedicated token', (t) => {
  for (const f of BARS) {
    const src = read(f)
    t.ok(src.includes('bg-progress-track'), `${f}: track uses bg-progress-track`)
    t.absent(/bg-surface-container-\w+ rounded-full overflow-hidden/.test(src), `${f}: no surface token left on a track`)
  }
})

test('REGRESSION (FIX-7): peer-dropdown divider survives the card hover lift', (t) => {
  const src = read('src/renderer/components/cards/PeerDownloadDropdown.tsx')
  t.absent(src.includes('divide-outline-variant'), 'divider is not outline-variant (== the dark hover lift)')
  t.ok(src.includes('divide-progress-track'), 'divider uses the hover-proof neutral token')
})
