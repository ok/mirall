import test from 'brittle'
import { readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/renderer')

// The flat root was model + platform + shell + format + errors + types with no signal: 53 modules
// in three casings and four typing regimes. These four are the only things that belong at the top
// of a runtime — the entry, the app, its router, and the package marker.
const ALLOWED = new Set(['main.tsx', 'app.tsx', 'ScreenRouter.tsx', 'package.json'])

test('nothing new lands at the renderer root', (t) => {
  const strays = readdirSync(ROOT)
    .filter((f) => !statSync(path.join(ROOT, f)).isDirectory())
    .filter((f) => !ALLOWED.has(f))
  t.alike(strays.sort(), [], 'the root holds only the entry, the app, the router and package.json')
})

// A bucket is a decision, so it takes a row here. store/, hooks/, keyboard/, notifications/,
// components/, screens/, locales/ and styles/ predate this split.
const BUCKETS = ['components', 'errors', 'format', 'hooks', 'ipc', 'keyboard', 'locales', 'model',
  'notifications', 'platform', 'screens', 'shell', 'store', 'styles', 'types']

test('every renderer folder is a named bucket', (t) => {
  const actual = readdirSync(ROOT).filter((f) => statSync(path.join(ROOT, f)).isDirectory()).sort()
  t.alike(actual, [...BUCKETS].sort(), 'a new renderer folder takes a row here')
})

// coding.md §2: kebab-case for modules everywhere. The root carried 33 camelCase names in three
// casings. components/ and screens/ are PascalCase by the same rule, and hooks are use*, so only
// the module buckets are held to this.
const KEBAB_BUCKETS = ['shell', 'ipc', 'platform', 'model', 'format', 'errors', 'types']

test('every module in a renderer bucket is kebab-case', (t) => {
  const bad = []
  for (const bucket of KEBAB_BUCKETS) {
    for (const file of readdirSync(path.join(ROOT, bucket))) {
      const base = file.replace(/\.d\.ts$/, '').replace(/\.(ts|tsx|js)$/, '')
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(base)) bad.push(`${bucket}/${file}`)
    }
  }
  t.alike(bad.sort(), [], 'coding.md §2: kebab-case for modules')
})
