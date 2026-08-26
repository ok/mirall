import test from 'brittle'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const KEYBOARD_DIR = join(root, 'src', 'renderer', 'keyboard')
const RENDERER_DIR = join(root, 'src', 'renderer')

// The catalogue is TypeScript the Node test runner can't import directly, so it is
// transpiled in memory. It imports nothing but types, which esbuild strips.
function loadModule (name) {
  const src = readFileSync(join(KEYBOARD_DIR, name), 'utf8')
  const { code } = transformSync(src, { loader: 'ts', format: 'cjs' })
  const mod = { exports: {} }
  new Function('module', 'exports', code)(mod, mod.exports)
  return mod.exports
}

const { KEYBOARD_SHORTCUTS, acceleratorFor, spaceDigitAccelerator } = loadModule('known-commands.ts')
const { parseAccelerator } = loadModule('accelerator.ts')

function rendererSources (exclude = []) {
  return readdirSync(RENDERER_DIR, { recursive: true })
    .filter((f) => typeof f === 'string' && (f.endsWith('.ts') || f.endsWith('.tsx')))
    .filter((f) => !exclude.some((name) => f.endsWith(name)))
    .map((f) => readFileSync(join(RENDERER_DIR, f), 'utf8'))
    .join('\n')
}

test('no two catalogue entries claim the same accelerator', (t) => {
  // Loaded under Node, so nav.home resolves to its Windows/Linux chord; the mac
  // variant is checked separately because that is the one that can collide with ⌘⇧U.
  for (const home of ['mod+h', 'mod+shift+h']) {
    const seen = new Map()
    for (const c of KEYBOARD_SHORTCUTS) {
      const accel = c.id === 'nav.home' ? home : c.accelerator
      t.absent(seen.has(accel), `${accel} claimed once (${c.id}${seen.has(accel) ? ' collides with ' + seen.get(accel) : ''})`)
      seen.set(accel, c.id)
    }
  }
})

test('every catalogue accelerator parses to a real key', (t) => {
  for (const c of KEYBOARD_SHORTCUTS) {
    const parsed = parseAccelerator(c.accelerator)
    t.ok(parsed.key.length > 0, `${c.id} has a key`)
    t.is(c.accelerator, c.accelerator.toLowerCase(), `${c.id} is lowercase`)
    if (c.acceleratorRangeEnd) t.ok(parseAccelerator(c.acceleratorRangeEnd).key.length > 0, `${c.id} range end has a key`)
  }
})

test('every catalogue id is registered by a call site', (t) => {
  const sources = rendererSources()
  for (const c of KEYBOARD_SHORTCUTS) {
    if (c.dynamic) continue
    t.ok(sources.includes(`id: '${c.id}'`), `${c.id} is registered somewhere in the renderer`)
  }
})

test('every catalogue entry has a label key that exists in English', (t) => {
  const en = JSON.parse(readFileSync(join(RENDERER_DIR, 'locales', 'en', 'common.json'), 'utf8'))
  for (const c of KEYBOARD_SHORTCUTS) {
    const value = c.labelKey.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), en)
    t.ok(typeof value === 'string' && value.length > 0, `${c.labelKey} is translated`)
  }
})

test('call sites do not hardcode accelerators', (t) => {
  // The catalogue is the only place a chord may be spelled out; the per-space digits are computed.
  const sources = rendererSources(['known-commands.ts'])
  const hardcoded = sources.match(/accelerator: '[^']+'/g) ?? []
  t.alike(hardcoded, [], 'no literal accelerator outside the catalogue')
})

test('dynamic entries are excluded from the id lookup', (t) => {
  for (const c of KEYBOARD_SHORTCUTS) {
    if (c.dynamic) t.is(acceleratorFor(c.id), undefined, `${c.id} is not resolvable by id`)
    else t.is(acceleratorFor(c.id), c.accelerator, `${c.id} resolves to its chord`)
  }
})

test('space digit accelerators cover exactly the documented range', (t) => {
  const range = KEYBOARD_SHORTCUTS.find((c) => c.id === 'space.openNth')
  t.ok(range, 'the digit range is documented in the cheatsheet')
  // The cheatsheet row is the contract: what it advertises is what gets bound.
  const last = Number(range.acceleratorRangeEnd.replace('mod+digit', ''))
  t.is(spaceDigitAccelerator(0), range.accelerator, 'first space matches the range start')
  t.is(spaceDigitAccelerator(last - 1), range.acceleratorRangeEnd, 'last space matches the range end')
  t.is(spaceDigitAccelerator(last), undefined, 'nothing past the range gets a chord')
})
