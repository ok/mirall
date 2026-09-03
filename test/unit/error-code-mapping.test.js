import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { ERROR_I18N_KEY_BY_CODE } from '../../src/renderer/errorMessages.js'

// REGRESSION (FIX-DLDIR-3: DOWNLOAD_FAILED was a code the download engine emits and the renderer
// had no mapping for, so it fell through to the generic "Transfer failed" — which is how an entire
// class of local-filesystem failures, a deleted or ejected download folder among them, reached the
// user as a message they could do nothing with).
//
// The failure mode is silent by construction: an unmapped code does not throw, it renders
// plausible-looking text. i18n-key-parity.test.js covers en<->locale parity; contract-errors covers
// worker<->renderer coverage; this file covers renderer<->catalog.

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(here, '../../src')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')

const enErrors = JSON.parse(read('renderer/locales/en/errors.json'))

// A mapping that points at a key no catalog defines renders the raw key string to the user —
// the same silent-garbage outcome as no mapping at all.
test('every mapped i18n key exists in the en errors catalog', (t) => {
  for (const [code, key] of Object.entries(ERROR_I18N_KEY_BY_CODE)) {
    t.ok(Object.hasOwn(enErrors, key), `${code} → errors.${key} exists`)
  }
})

// Derived from the engine source rather than hand-listed, so a code added there in future is
// covered without anyone remembering to update this test.
test('REGRESSION (FIX-DLDIR-3: every code the download engine emits has a renderer mapping)', (t) => {
  const engineSrc = read('shared/transfer/backends/overlay/overlay-download.js')
  const emitted = new Set([...engineSrc.matchAll(/ErrorCodes\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]))
  t.ok(emitted.size > 0, 'the engine references error codes at all')
  for (const code of emitted) {
    t.ok(code in ERROR_I18N_KEY_BY_CODE, `${code} is mapped in errorMessages.js (not silently generic)`)
  }
})

// A mount fault's reason lands mid-sentence in the folder screen's fault strip, so it has its own
// fallback rather than "Transfer failed". An unclassified fault — or a record written before the
// reason became a code, whose reason is a raw errno message — resolves through it.
test('the mount-fault reason has a named fallback and a string behind it', (t) => {
  t.ok(errorMessagesSrc.includes("return 'mountFaultUnknown'"), 'mountFaultReasonKey falls back to a named key')
  t.ok(Object.hasOwn(enErrors, 'mountFaultUnknown'), 'and the key exists in the en errors catalog')
})

// The owner and the mirror both record these two codes as a mount fault's reason, and the strip
// renders them through the transfer map — so an unmapped one would silently read as the fallback.
test('every code a mount fault can record is mapped', (t) => {
  const mapped = new Set(transferMap.map(([code]) => code))
  for (const code of ['TRANSFER_DISK_FULL', 'TRANSFER_PERMISSION']) {
    t.ok(mapped.has(code), `${code} is mapped in errorMessages.ts`)
  }
})
