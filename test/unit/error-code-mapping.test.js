import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// REGRESSION (FIX-DLDIR-3: DOWNLOAD_FAILED was a code the download engine emits and the renderer
// had no mapping for, so it fell through errorCodeToI18nKey's default to the generic "Transfer
// failed" — which is how an entire class of local-filesystem failures, a deleted or ejected
// download folder among them, reached the user as a message they could do nothing with).
//
// The failure mode is silent by construction: an unmapped code does not throw, it renders
// plausible-looking text. Nothing else catches it — the locale parity guard checks that all five
// locales agree, not that a code the worker can send has anywhere to land — so these two
// invariants are what keep the next new code from repeating it.
//
// i18n-key-parity.test.js covers en↔locale parity; this file covers worker↔renderer.

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(here, '../../src')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')

const errorMessagesSrc = read('renderer/errorMessages.ts')
const enErrors = JSON.parse(read('renderer/locales/en/errors.json'))

// Both maps are plain object literals of `CODE: 'i18nKey',` — parse them out rather than
// importing, since this is a Node runner and the source is TypeScript.
function mapEntries (constName) {
  const start = errorMessagesSrc.indexOf(`const ${constName}`)
  if (start === -1) return []
  const body = errorMessagesSrc.slice(start, errorMessagesSrc.indexOf('\n}', start))
  return [...body.matchAll(/^\s*([A-Z][A-Z0-9_]*):\s*'([^']+)'/gm)].map((m) => [m[1], m[2]])
}

const transferMap = mapEntries('ERROR_I18N_KEY_BY_CODE')
const mountMap = mapEntries('MOUNT_ERROR_I18N_KEY_BY_CODE')

test('the renderer error maps were parsed (guards the parser itself)', (t) => {
  t.ok(transferMap.length >= 8, `found ${transferMap.length} transfer mappings`)
  t.ok(mountMap.length >= 8, `found ${mountMap.length} mount mappings`)
})

// A mapping that points at a key no catalog defines renders the raw key string to the user —
// the same silent-garbage outcome as no mapping at all.
test('every mapped i18n key exists in the en errors catalog', (t) => {
  for (const [code, key] of [...transferMap, ...mountMap]) {
    t.ok(Object.hasOwn(enErrors, key), `${code} → errors.${key} exists`)
  }
})

// REGRESSION (FIX-DLDIR-3). Derived from the engine source rather than hand-listed, so a code
// added there in future is covered without anyone remembering to update this test.
test('REGRESSION (FIX-DLDIR-3: every code the download engine emits has a renderer mapping)', (t) => {
  const engineSrc = read('shared/transfer/backends/overlay/overlay-download.js')
  const emitted = new Set([...engineSrc.matchAll(/ErrorCodes\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]))
  t.ok(emitted.size > 0, 'the engine references error codes at all')

  const mapped = new Set(transferMap.map(([code]) => code))
  for (const code of emitted) {
    t.ok(mapped.has(code), `${code} is mapped in errorMessages.ts (not silently generic)`)
  }
})
