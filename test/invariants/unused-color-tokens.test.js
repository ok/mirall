import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')

// Tokens with a consumer the class scan cannot see, each with its site. The boot screen in
// assets/index.html paints with these before the bundle loads.
const ALLOW = new Set(['background', 'on-background'])

const UTILITY = 'bg|text|border|ring|fill|stroke|from|to|via|outline|decoration|shadow|accent|caret|divide|placeholder'

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'dist' && name !== 'node_modules' && name !== 'vendor') walk(p, out) }
    else if (/\.(js|mjs|ts|tsx|html|css)$/.test(name)) out.push(p)
  }
  return out
}

// Only the files that can STYLE something: the renderer, the boot html and the layout-harness
// entries. Unit tests are excluded on purpose — status-badge.test.js names bg-secondary-fixed to
// assert it is gone, which must not count as a consumer.
function corpus() {
  const files = [
    ...walk(path.join(root, 'src')),
    ...walk(path.join(root, 'test', 'frontend-layout')),
    path.join(root, 'assets', 'index.html')
  ].filter((f) => !f.endsWith(path.join('styles', 'tailwind.css')) && !f.endsWith('tailwind.config.js'))
  return files.map((f) => readFileSync(f, 'utf8')).join('\n')
}

function tokens() {
  const config = readFileSync(path.join(root, 'tailwind.config.js'), 'utf8')
  return [...config.matchAll(/^\s*'([a-z][a-z0-9-]*)':\s*'var\(--color-\1\)'/gm)].map((m) => m[1])
}

function consumed(tok, text) {
  const esc = tok.replace(/-/g, '\\-')
  // `text-on-surface-variant` must not count for `surface-variant`: the utility prefix has to sit
  // directly in front of the token, and the token must end there.
  const utility = new RegExp(`(^|[^a-z0-9-])(${UTILITY})-${esc}(?![a-z0-9-])`)
  const cssVar = new RegExp(`--color-${esc}(?![a-z0-9-])`)
  const theme = new RegExp(`theme\\([^)]*(^|[^a-z0-9-])${esc}(?![a-z0-9-])`)
  return utility.test(text) || cssVar.test(text) || theme.test(text)
}

test('every colour token in tailwind.config.js is used by a utility class, a var() or theme()', (t) => {
  const all = tokens()
  t.ok(all.length > 30, `parsed ${all.length} tokens from tailwind.config.js`)
  const text = corpus()
  t.ok(text.length > 100000, 'the renderer was actually scanned')
  t.ok(consumed('accent', text), 'the scan can see a live token')
  t.absent(consumed('no-such-token', text), 'and cannot be fooled by a name nothing uses')
  const unused = all.filter((tok) => !ALLOW.has(tok) && !consumed(tok, text))
  t.alike(unused, [], 'tokens with no consumer — delete them from tailwind.css (:root and .dark) and tailwind.config.js, or name their consumer in ALLOW')
})

// The three declarations must stay in step: a token in the config without CSS is transparent, a
// CSS variable without a config entry is unreachable from a class.
test('tailwind.css declares every config token in both themes, and nothing else', (t) => {
  const css = readFileSync(path.join(root, 'src', 'renderer', 'styles', 'tailwind.css'), 'utf8')
  const blocks = [...css.matchAll(/(:root|\.dark)\s*\{([\s\S]*?)\n\}/g)].map((m) => [m[1], [...m[2].matchAll(/--color-([a-z][a-z0-9-]*):/g)].map((x) => x[1]).sort()])
  const configured = tokens().sort()
  t.is(blocks.length, 2, 'found :root and .dark')
  for (const [name, declared] of blocks) t.alike(declared, configured, `${name} declares exactly the configured tokens`)
})
