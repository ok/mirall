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

test('REGRESSION (FIX-1): on-info fill clears 3:1 vs track AND hover pill, both themes', (t) => {
  for (const theme of [':root', '.dark']) {
    const k = tokensFor(theme)
    const cTrack = contrast(k['color-on-info'], k['color-surface-container-highest'])
    const cHover = contrast(k['color-on-info'], k['color-surface-container-high'])
    t.ok(cTrack >= 3.0, `${theme}: on-info vs track = ${cTrack.toFixed(2)}:1`)
    t.ok(cHover >= 3.0, `${theme}: on-info vs hover pill = ${cHover.toFixed(2)}:1`)
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
