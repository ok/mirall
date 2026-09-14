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
