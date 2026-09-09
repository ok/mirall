import test from 'brittle'
import { readdirSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'

// One rule governs every interactive fill in the app: **on hover a control steps ~5 L* AWAY from
// the page behind it** — darker in light mode, where the page is the lightest thing on screen,
// lighter in dark mode, where it is the darkest. That is already how the transparent controls
// behave (rows and cards lift to `surface-container-highest`, the subtle icon triggers to
// `surface-container-high`, menu items to `surface-container-low`), and the filled variants now
// follow it too, so the pointer produces one gesture everywhere instead of three.
//
// Steering by "away from the page" rather than "always downwards" is what keeps the rule
// affordable: it moves each fill AWAY from its own label in exactly one theme, never both, so no
// variant has to spend its AA headroom to be felt. The version this replaced darkened every fill
// in both themes and had to stop at whatever contrast allowed — the dark orange at 4.75:1, the
// light neutral 8x its old step — which is how one gesture ended up looking like six.
//
// Checked here: the direction, the size of the step, AA on every label over both the rest fill and
// the hover fill, the neutral's clearance from the page, and the one pairing (`error-container`
// carries `on-error-container`, never `error`) that a fill change can silently break.

const root = new URL('../../', import.meta.url)
const read = (p) => readFileSync(fileURLToPath(new URL(p, root)), 'utf8')

const css = read('src/renderer/styles/tailwind.css')
const chips = read('src/renderer/screens/SharedSpaces.tsx')
const button = read('src/renderer/components/primitives/Button.tsx')

// Every .tsx under the renderer, so a pattern check cannot go stale by a control moving file.
const rendererSources = (dir = 'src/renderer') => {
  const out = []
  for (const entry of readdirSync(fileURLToPath(new URL(dir, root)), { withFileTypes: true })) {
    const p = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...rendererSources(p))
    else if (entry.name.endsWith('.tsx')) out.push(p)
  }
  return out
}

const tokensFor = (selector) => {
  const start = css.indexOf(selector + ' {')
  const block = css.slice(start, css.indexOf('\n}', start))
  const out = {}
  for (const m of block.matchAll(/--(color-[\w-]+):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]] = m[2]
  return out
}

const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
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
// CIE L* depends on luminance alone, so the perceptual step design.md quotes is computable here.
const lstar = (hex) => {
  const y = lum(hex)
  return 116 * (y > 216 / 24389 ? Math.cbrt(y) : (841 / 108) * y + 4 / 29) - 16
}

// base → hover, plus every ink rendered on top of the pair.
const VARIANTS = [
  { name: 'primary', base: 'color-primary', hover: 'color-primary-hover', inks: ['color-on-primary'] },
  { name: 'neutral', base: 'color-surface-control', hover: 'color-surface-control-hover', inks: ['color-on-surface-variant', 'color-accent'] },
  { name: 'danger', base: 'color-error-container', hover: 'color-error-container-hover', inks: ['color-on-error-container'] },
]
// Light mode's page is the lightest surface, dark mode's the darkest, so "away from the page" is
// a sign per theme.
const AWAY = { ':root': -1, '.dark': +1 }
// The two fills that cannot obey it, both for the same reason: they live at the ends of the ramp,
// where outward has nothing left. The orange is at the sRGB edge — lighter is simply not available
// at that chroma, and +3.3 L* read as no hover at all. The plum is at the other end, where outward
// means darker and the black floor eats the difference. Both step INWARD instead, which is safe for
// the reason the rule exists: each stays tens of L* clear of the page, so the control cannot get
// lost against it.
const INWARD = [
  { theme: '.dark', variant: 'primary' },
  { theme: ':root', variant: 'primary' },
]
const MIN_PAGE_GAP = 30

// What it takes for a step to be FELT is not constant across the palette, and it is not about the
// fill being dark: the dark neutral steps 5.1 L* at L*31 and reads fine, while the old plum's 4.9
// at L*17 was invisible. The predictor is distance from the PAGE, because that is what the eye is
// adapted to — a fill far from it (the plum 68 L* below a near-white page, the orange 55 L* above
// a near-black one) sits outside that adaptation, where small differences compress. Those two owe
// a bigger step; fills that live near the page can be felt with less.
const MIN_STEP = (fill, page) => (Math.abs(fill - page) > 45 ? 6.5 : 4.5)

test('every fill keeps its label at AA, at rest and on hover', (t) => {
  for (const theme of [':root', '.dark']) {
    const k = tokensFor(theme)
    for (const v of VARIANTS) {
      for (const ink of v.inks) {
        for (const state of ['base', 'hover']) {
          const c = contrast(k[ink], k[v[state]])
          t.ok(c >= 4.5, `${theme} ${v.name} ${state}: ${ink} = ${c.toFixed(2)}:1`)
        }
      }
    }
  }
})

// REGRESSION (FIX-2: hovers that darkened in BOTH themes ran into the label instead of the page —
// the dark orange could only reach 4.75:1, and the light neutral had to take an 8x step to be felt.)
// REGRESSION (FIX-3: a uniform ~5 L* step left both brand fills without a visible hover — the plum
// because it sat at the bottom of the ramp, the orange because sRGB capped it at 3.3.)
test('REGRESSION (FIX-2, FIX-3): every hover steps away from the page, far enough to be felt', (t) => {
  for (const theme of [':root', '.dark']) {
    const k = tokensFor(theme)
    for (const v of VARIANTS) {
      const base = lstar(k[v.base]), hover = lstar(k[v.hover])
      const step = hover - base
      const inward = INWARD.some((x) => x.theme === theme && x.variant === v.name)
      if (inward) {
        const gap = Math.abs(hover - lstar(k['color-background']))
        t.ok(gap >= MIN_PAGE_GAP,
          `${theme} ${v.name}: steps toward the page but stays ${gap.toFixed(1)} L* clear of it`)
      } else {
        t.ok(Math.sign(step) === AWAY[theme], `${theme} ${v.name}: steps away from the page (ΔL* ${step.toFixed(1)})`)
      }
      const need = MIN_STEP(base, lstar(k['color-background']))
      t.ok(Math.abs(step) >= need && Math.abs(step) <= 10,
        `${theme} ${v.name}: step is ${Math.abs(step).toFixed(1)} L* (needs ${need}-10)`)
    }
  }
})

// The plum is a fill, not an ink. `accent` carries the text role in light mode and stays where it
// was; lifting the BUTTON off the ramp floor is what bought its hover room, and conflating the two
// tokens again would drag every heading up with it.
test('light-mode primary is a fill that has left accent behind', (t) => {
  const k = tokensFor(':root')
  t.not(k['color-primary'], k['color-accent'], 'primary is no longer an alias of accent')
  t.is(k['color-accent'], '#33253b', 'accent still carries the heading/text plum')
  // The pair, not the rest fill, is what needs room: the button rests at the dark end and hovers
  // toward the light one, so it is the LIGHTER of the two that has to sit off the ramp floor. On
  // the floor (the old #33253b/#281b30 pair) a 5 L* step was invisible to the person using it.
  const lighter = Math.max(lstar(k['color-primary']), lstar(k['color-primary-hover']))
  t.ok(lighter >= 27, `the plum pair reaches up off the ramp floor (L* ${lighter.toFixed(1)})`)
  const src = read('src/renderer/screens/SharedSpaces.tsx') + read('src/renderer/components/primitives/Button.tsx')
  t.absent(/text-primary\b/.test(src), 'primary is never used as an ink')
})

// The neutral is the one that can vanish: it is a plain surface a few L* off the page, with no hue
// of its own to hold the edge. Both of its states have to stay a visible object.
test('the neutral control stays clear of the page behind it', (t) => {
  for (const theme of [':root', '.dark']) {
    const k = tokensFor(theme)
    for (const state of ['color-surface-control', 'color-surface-control-hover']) {
      const gap = Math.abs(lstar(k[state]) - lstar(k['color-background']))
      t.ok(gap >= 5, `${theme} ${state}: clears the page by ${gap.toFixed(1)} L*`)
    }
  }
})

// The tonal red is the one fill that gets painted under a foreign ink: a destructive row is
// `text-error` at rest and only meets the fill on hover. `error` on `error-container` is 2.94:1 in
// dark — under even the 3:1 non-text floor — so the fill has to bring `on-error-container` with it.
test('the error-container fill is never painted under text-error', (t) => {
  // Walked, not listed: a hardcoded set of files silently loses coverage the moment a
  // destructive control moves (the relay row's delete button became an ActionMenu `danger`
  // item, and the list still named the file it had left). Walking also covers a NEW file
  // painting the fill, which a list can never do.
  let checked = 0
  for (const f of rendererSources()) {
    const src = read(f)
    for (const m of src.matchAll(/hover:bg-error-container(?!-)/g)) {
      checked++
      t.ok(/hover:text-on-error-container/.test(src.slice(m.index, m.index + 160)),
        `${f}: the error-container hover brings its own ink`)
    }
  }
  t.ok(checked >= 2, `all ${checked} error-container hovers were reached`)
})

// REGRESSION (FIX-1: the selected chip carried `bg-primary` with no hover class at all).
test('REGRESSION (FIX-1): both spaces-filter chip states name a hover colour', (t) => {
  const start = chips.indexOf('aria-pressed={filter === f}')
  t.ok(start > 0, 'the filter chips were found at all')
  const chipClasses = chips.slice(start, chips.indexOf('</button>', start))
  t.ok(/'bg-primary [^']*hover:bg-primary-hover/.test(chipClasses), 'selected chip hovers to primary-hover')
  t.ok(/'bg-surface-control [^']*hover:bg-surface-control-hover/.test(chipClasses), 'unselected chip hovers to surface-control-hover')
})

test('the chips hover to the same tokens as the Create/Join buttons beside them', (t) => {
  for (const pair of ['bg-primary', 'bg-surface-control']) {
    const hover = new RegExp(`${pair}[^'\`]*hover:${pair}-hover`)
    t.ok(hover.test(button), `Button still pairs ${pair} with ${pair}-hover`)
  }
})
