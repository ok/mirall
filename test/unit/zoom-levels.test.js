// The Zoom control's preset ladder (src/renderer/hooks/useZoom.ts). The persisted factor is
// continuous — main steps it by 0.05 inside a 0.5-1.5 clamp — so the control has to resolve an
// arbitrary factor to one of four named rungs.
import test from 'brittle'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// TypeScript the Node runner can't import directly. Its React and store imports are stubbed:
// only the hook body reads them, and the ladder under test is plain data.
function loadModule (relPath) {
  const src = readFileSync(join(root, relPath), 'utf8')
  const { code } = transformSync(src, { loader: 'ts', format: 'cjs' })
  const mod = { exports: {} }
  const stubRequire = () => ({ useCallback: (fn) => fn, useMainQuery: () => ({}) })
  new Function('module', 'exports', 'require', code)(mod, mod.exports, stubRequire)
  return mod.exports
}

const { ZOOM_LEVELS, nearestZoomLevel } = loadModule('src/renderer/hooks/useZoom.ts')

test('every preset resolves to itself', (t) => {
  for (const level of ZOOM_LEVELS) {
    t.is(nearestZoomLevel(level.factor).key, level.key, `${level.factor} is ${level.key}`)
  }
})

// REGRESSION (FIX-219: the control compared the factor to each preset within 0.005, so every
// factor main's 0.05 step produces that is not itself a preset — 0.90, 0.95, 1.05, 1.15 — lit no
// tile at all, leaving a screen reader told nothing was selected while zoom was plainly applied).
test('REGRESSION (FIX-219): a factor between presets marks exactly one tile', (t) => {
  const cases = [
    [0.90, 'cozy'],
    [0.95, 'cozy'],
    [1.05, 'default'],
    [1.15, 'spacious'],
    [1.20, 'spacious'],
  ]
  for (const [factor, key] of cases) {
    t.is(nearestZoomLevel(factor).key, key, `${factor} → ${key}`)
    const marked = ZOOM_LEVELS.filter((l) => l.key === nearestZoomLevel(factor).key)
    t.is(marked.length, 1, `${factor} marks exactly one preset`)
  }
})

test('a factor past either end of the ladder takes the end rung', (t) => {
  t.is(nearestZoomLevel(0.5).key, 'compact', 'the 0.5 clamp floor is Compact')
  t.is(nearestZoomLevel(0.1).key, 'compact', 'below the ladder is Compact')
  t.is(nearestZoomLevel(1.5).key, 'spacious', 'the 1.5 clamp ceiling is Spacious')
  t.is(nearestZoomLevel(9).key, 'spacious', 'above the ladder is Spacious')
})

test('a factor exactly between two presets takes the lower one', (t) => {
  t.is(nearestZoomLevel(0.885).key, 'compact', 'midway between 0.85 and 0.92')
  t.is(nearestZoomLevel(0.96).key, 'cozy', 'midway between 0.92 and 1.0')
  t.is(nearestZoomLevel(1.05).key, 'default', 'midway between 1.0 and 1.10')
})
