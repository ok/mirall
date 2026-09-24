import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '../..')
const SCANNED = ['src', 'scripts', 'test']
// The one test that feeds the retired keys in on purpose, to prove they are dropped.
const ALLOWED = new Set(['test/unit/runtime-config.test.js', 'test/invariants/no-content-flags.test.js'])
// The runtime-config keys and accessors, the feature-flags.json keys as main or a harness would
// spell them, and the probe that reported them.
const RETIRED = /\b(overlayEnabled|inPlaceFilesEnabled|isOverlayEnabled|isInPlaceFilesEnabled|inPlaceFiles)\b|\boverlay\s*:\s*(true|false)\b|readFeatureFlags\(\)\.overlay\b|features:get/

function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name !== 'node_modules' && name !== 'vendor') sources(p, out)
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name)) out.push(p)
  }
  return out
}

// The overlay backend and in-place loose files are the only content strategy; a gate on either
// would reintroduce a path nothing tests.
test('no source file gates on the retired content flags', (t) => {
  const hits = SCANNED.flatMap((d) => sources(path.join(ROOT, d)))
    .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
    .filter((rel) => !ALLOWED.has(rel) && RETIRED.test(readFileSync(path.join(ROOT, rel), 'utf8')))
  t.alike(hits, [], 'no file names a retired content flag')
})

test('the shipped feature-flags.json carries no content flag', (t) => {
  const flags = JSON.parse(readFileSync(path.join(ROOT, 'feature-flags.json'), 'utf8'))
  t.absent('overlay' in flags, 'no overlay key')
  t.absent('inPlaceFiles' in flags, 'no inPlaceFiles key')
})
