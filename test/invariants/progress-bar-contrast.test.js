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
  'src/renderer/components/primitives/DownloadProgressLane.tsx',
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

// The peer dropdown's pill is a host the bar sits on, not the bar: its fill swaps under the card's
// hover lift, and FIX-6 holds the track clear of it.
const PILL_HOST = 'bg-surface-container-high group-hover:bg-surface-container-lowest'

test('REGRESSION (FIX-2): hover-pill token is never a static progress bg', (t) => {
  const re = /bg-surface-container-high(?![a-z])/g
  for (const f of BARS) {
    const src = read(f)
    for (const m of src.matchAll(re)) {
      if (src.startsWith(PILL_HOST, m.index)) continue
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

test('FIX-5: indeterminate sweep uses --color-on-info', (t) => {
  const sweep = classBlock('progress-indeterminate')
  t.ok(sweep.includes('var(--color-on-info)'), 'sweep background is on-info')
  t.absent(sweep.includes('--color-secondary-container'), 'sweep no longer secondary-container')
})

// Every surface a progress bar can rest on. Bars live inside file/folder rows that lift to
// `surface-container-highest` on hover, inside the peer-download toggle that lifts to
// `surface-container-high` (`-lowest` in light, under the row's lift), and inside modal panels (`surface-container-lowest`). A track
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

// The +N disc and the initials disc are fills on a card that lifts to `surface-container-highest`,
// so they are the same shape as the track: any ramp token they borrow is one the host can adopt
// under them. FIX-6's clearance table above covers the token; this pins the discs to it.
test('REGRESSION (FIX-RIM): every faceless avatar disc is painted in the hover-proof neutral', (t) => {
  for (const f of ['src/renderer/components/primitives/AvatarStack.tsx', 'src/renderer/components/primitives/Avatar.tsx']) {
    const src = read(f)
    t.ok(src.includes('bg-progress-track'), `${f}: the disc uses the hover-proof neutral`)
    t.absent(/bg-surface-container-\w+/.test(src), `${f}: no ramp surface left on a disc`)
  }
  // The Activity Log draws its actor disc by hand — same box, same row-hover host, same rule. The
  // file's other ramp tokens are badges, so this pins the disc's own class list rather than the file.
  const feed = read('src/renderer/components/activity/ActivityFeed.tsx')
  t.ok(/w-8 h-8 rounded-full bg-progress-track/.test(feed), 'the Activity Log actor disc uses the neutral')
  t.ok(/rounded-full bg-progress-track[^"]*avatar-recess/.test(feed), 'and is recessed like every other disc')
})

test('peer dropdown pills stand off the card at rest and under its hover lift, both themes', (t) => {
  const PILL = `${PILL_HOST} dark:group-hover:bg-surface-container-high`
  for (const f of ['src/renderer/components/cards/RecipientRow.tsx', 'src/renderer/components/cards/PeerDownloadRow.tsx']) {
    t.ok(read(f).includes(PILL), `${f}: the pill swaps its fill with the card's hover lift`)
  }
  const light = tokensFor(':root')
  const dark = tokensFor('.dark')
  const states = [
    ['light rest', light['color-surface-container-high'], light['color-surface-container-lowest'], light],
    ['light hover', light['color-surface-container-lowest'], light['color-surface-container-highest'], light],
    ['dark rest', dark['color-surface-container-high'], dark['color-surface-container-low'], dark],
    ['dark hover', dark['color-surface-container-high'], dark['color-surface-container-highest'], dark],
  ]
  for (const [state, pill, card, k] of states) {
    const off = contrast(pill, card)
    const text = contrast(k['color-on-surface-variant'], pill)
    t.ok(off >= TRACK_MIN, `${state}: pill vs card = ${off.toFixed(2)}:1`)
    t.ok(text >= 4.5, `${state}: text vs pill = ${text.toFixed(2)}:1`)
  }
})

test('peer dropdown pills carry presence on the dot, not the text', (t) => {
  for (const f of ['src/renderer/components/cards/RecipientRow.tsx', 'src/renderer/components/cards/PeerDownloadRow.tsx']) {
    t.absent(/text-(accent|outline)(?![\w-])/.test(read(f)), `${f}: no presence-tinted text`)
  }
})

test('REGRESSION (FIX-7): peer dropdown has no divider to lose under the card hover lift', (t) => {
  const src = read('src/renderer/components/cards/PeerDownloadDropdown.tsx')
  t.absent(/divide-/.test(src), 'rows are separated by spacing, not a divider')
})

// The info strip (a working folder, a running batch) is a host the shared track cannot clear: it
// sits near 1:1 on the strip's blue in both themes. A lane there paints its fill and its track from
// the strip's own foreground, the track at 28%, and the strip's text takes the same foreground.
const STRIP_TRACK_ALPHA = 0.28
const blend = (fg, bg, a) => '#' + [0, 2, 4].map((i) => {
  const f = parseInt(fg.slice(1 + i, 3 + i), 16), b = parseInt(bg.slice(1 + i, 3 + i), 16)
  return Math.round(f * a + b * (1 - a)).toString(16).padStart(2, '0')
}).join('')

test('REGRESSION (FIX-STRIP): the info strip stands off the page and its lane reads on it, both themes', (t) => {
  for (const theme of [':root', '.dark']) {
    const k = tokensFor(theme)
    const strip = k['color-info-container'], fg = k['color-on-info-container']
    t.ok(strip && fg, `${theme}: the info-container pair is defined`)
    if (!strip || !fg) continue
    const track = blend(fg, strip, STRIP_TRACK_ALPHA)
    t.ok(contrast(fg, strip) >= 4.5, `${theme}: strip text = ${contrast(fg, strip).toFixed(2)}:1`)
    t.ok(contrast(fg, track) >= 3.0, `${theme}: fill vs strip track = ${contrast(fg, track).toFixed(2)}:1`)
    t.ok(contrast(track, strip) >= TRACK_MIN, `${theme}: strip track vs strip = ${contrast(track, strip).toFixed(2)}:1`)
    t.ok(contrast(strip, k['color-surface']) >= TRACK_MIN, `${theme}: strip vs page = ${contrast(strip, k['color-surface']).toFixed(2)}:1`)
  }
  const lane = read('src/renderer/components/primitives/DownloadProgressLane.tsx')
  t.ok(lane.includes(`bg-on-info-container/${Math.round(STRIP_TRACK_ALPHA * 100)}`), 'the lane paints the strip track at the measured alpha')
  t.ok(lane.includes("'--lane-fill': 'var(--color-on-info-container)'"), 'the indeterminate sweep takes the strip foreground')
  t.ok(classBlock('progress-indeterminate').includes('var(--lane-fill, var(--color-on-info))'), 'the sweep reads the lane fill, on-info by default')
  for (const f of ['src/renderer/components/batch/BatchProgressStrip.tsx', 'src/renderer/components/folder/FolderWorkStrip.tsx']) {
    const src = read(f)
    t.ok(src.includes('bg-info-container text-on-info-container'), `${f}: the strip is the container pair`)
    t.absent(src.includes('bg-info/20'), `${f}: no alpha tint left`)
    t.ok(src.includes("'info-container'") || src.includes('host="info-container"'), `${f}: its lane is told it sits on the strip`)
  }
})
