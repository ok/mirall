import test from 'brittle'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import config from '../../eslint.config.mjs'
import { unmountOnlyAsyncEffects, outOfOrderAsyncEffects } from '../../eslint-rules/invariants.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const isGlob = (spec) => /[*?[\]{}]/.test(spec)

// A files: entry naming one literal path is a single-owner rule. Rename the owner and the entry
// matches nothing, eslint reports nothing, and the invariant is gone with no red anywhere —
// pureTransferModules sat unenforced that way from the day it was written. Globs are exempt: a glob
// is allowed to match nothing.
test('every literal path an eslint block names exists', (t) => {
  const missing = []
  for (const block of config) {
    for (const spec of block.files ?? []) {
      if (typeof spec !== 'string' || isGlob(spec)) continue
      if (!existsSync(path.join(root, spec))) missing.push(spec)
    }
  }
  t.alike(missing.sort(), [], 'eslint blocks name files that no longer exist')
})

// The async-effect tables are keyed by path too. renderer-stale-guard-ratchet catches a stale key
// via its own scan, but only for files that scan reaches.
test('every async-effect exemption names a file that exists', (t) => {
  const keys = [...Object.keys(unmountOnlyAsyncEffects), ...Object.keys(outOfOrderAsyncEffects)]
  const missing = keys.filter((key) => !existsSync(path.join(root, key)))
  t.alike(missing.sort(), [], 'async-effect exemptions name files that no longer exist')
})
