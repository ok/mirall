import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'

const root = new URL('../../', import.meta.url)
const read = (p) => readFileSync(fileURLToPath(new URL(p, root)), 'utf8')

const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
const rgb = (hex) => [0, 2, 4].map((i) => parseInt(hex.replace('#', '').slice(i, i + 2), 16))
const lum = (hex) => { const [r, g, b] = rgb(hex).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
// An alpha colour as painted over its ground.
const over = (fg, bg, alpha) => '#' + rgb(fg).map((c, i) => Math.round(alpha * c + (1 - alpha) * rgb(bg)[i])
  .toString(16).padStart(2, '0')).join('')

const css = read('src/renderer/styles/tailwind.css')
const tokensFor = (selector) => {
  const start = css.indexOf(selector + ' {')
  const block = css.slice(start, css.indexOf('}', start))
  const out = {}
  for (const m of block.matchAll(/--color-([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]] = m[2]
  return out
}
const THEMES = [[':root', 'light'], ['.dark', 'dark']]

// Every fill a text or search field takes.
const FIELD_FILLS = ['surface-container-low', 'surface-container-lowest']
// Every ground error text is painted on: the field fills, the screen, and the hover lift of a file row.
const ERROR_GROUNDS = [...FIELD_FILLS, 'surface', 'surface-container-highest']

const textField = read('src/renderer/components/primitives/TextField.tsx')

test('REGRESSION (FIELD-1): the field placeholder clears 4.5:1 on every field fill, both themes', (t) => {
  const m = textField.match(/FIELD_PLACEHOLDER = 'placeholder:text-([\w-]+)\/(\d+)'/)
  t.ok(m, 'TextField exports FIELD_PLACEHOLDER as a token with an alpha')
  if (!m) return
  const [, token, pct] = m
  for (const [sel, theme] of THEMES) {
    const k = tokensFor(sel)
    for (const fill of FIELD_FILLS) {
      const c = contrast(over(k[token], k[fill], pct / 100), k[fill])
      t.ok(c >= 4.5, `${theme}: placeholder ${token}/${pct} on ${fill} = ${c.toFixed(2)}:1`)
    }
  }
})

test('REGRESSION (FIELD-2): no placeholder is painted with a border token', (t) => {
  // outline and outline-variant are the badge/dropzone border tokens; as text they fail AA everywhere.
  t.absent(/FIELD_PLACEHOLDER = 'placeholder:text-outline/.test(textField), 'FIELD_PLACEHOLDER is not an outline token')
})

test('REGRESSION (FIELD-3): error text clears 4.5:1 on every ground it is painted on, both themes', (t) => {
  for (const [sel, theme] of THEMES) {
    const k = tokensFor(sel)
    for (const g of ERROR_GROUNDS) {
      const c = contrast(k.error, k[g])
      t.ok(c >= 4.5, `${theme}: error on ${g} = ${c.toFixed(2)}:1`)
    }
  }
})

// A settings card is surface-container-low, so a field filled -low inside it has no visible edge at
// all; a modal panel is -lowest, so a field there needs -low. The fill follows from where the field
// is, never from a prop a caller can forget.
test('REGRESSION (FIELD-4): a field takes the fill its ground needs, without the caller choosing', (t) => {
  const ground = read('src/renderer/components/primitives/FieldGround.tsx')
  t.ok(/createContext<FieldFill>\('lowest'\)/.test(ground), 'outside a modal, a field is filled -lowest')
  const modal = read('src/renderer/components/primitives/Modal.tsx')
  t.ok(/<FieldGround fill="low">\{children\}<\/FieldGround>/.test(modal), 'Modal fills the fields in its panel -low')
  t.ok(/DEFAULT_PANEL = 'glass-modal /.test(modal), 'the modal panel is still glass-modal')
  t.ok(/\.glass-modal \{\s*background: var\(--color-surface-container-lowest\)/.test(css), 'glass-modal is still -lowest')
  for (const f of ['primitives/TextField.tsx', 'primitives/SearchField.tsx', 'path/PathRow.tsx']) {
    t.ok(/useFieldFill\(\)/.test(read(`src/renderer/components/${f}`)), `${f} reads its fill from the ground`)
  }
})

// The off switch is identified by its outline and knob, not by its fill. Both are on-surface-variant
// and must clear 3:1 against every card the switch rests on, at rest and under the row's hover tint.
test('REGRESSION (FIELD-5): an off switch clears 3:1 on its card at rest and under hover, both themes', (t) => {
  const toggle = read('src/renderer/components/primitives/Toggle.tsx')
  t.ok(/border-on-surface-variant/.test(toggle), 'the off track is outlined in on-surface-variant')
  t.ok(/bg-on-surface-variant/.test(toggle), 'the off knob is on-surface-variant')
  for (const [sel, theme] of THEMES) {
    const k = tokensFor(sel)
    const grounds = {
      'card -low': k['surface-container-low'],
      'card -lowest': k['surface-container-lowest'],
      'row hover (-high/50 over -low)': over(k['surface-container-high'], k['surface-container-low'], 0.5),
    }
    for (const [name, g] of Object.entries(grounds)) {
      const c = contrast(k['on-surface-variant'], g)
      t.ok(c >= 3, `${theme}: off switch on ${name} = ${c.toFixed(2)}:1`)
    }
    const on = contrast(k.primary, k['surface-container-low'])
    const knob = contrast(k['on-primary'], k.primary)
    t.ok(on >= 3, `${theme}: on track vs card = ${on.toFixed(2)}:1`)
    t.ok(knob >= 3, `${theme}: on knob vs track = ${knob.toFixed(2)}:1`)
  }
})

test('every switch is drawn by ToggleSwitch', (t) => {
  const audit = read('src/renderer/screens/settings/AuditRecordingCard.tsx')
  t.ok(/<ToggleSwitch\b/.test(audit), 'the Activity Log recording switch renders ToggleSwitch')
})
