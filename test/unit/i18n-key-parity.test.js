import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// Every locale must carry the SAME translation keys as the reference (en) for
// every namespace — a missing key silently falls back to the key string in the
// UI, an extra key is dead weight. No such guard existed before; this also pins
const here = path.dirname(fileURLToPath(import.meta.url))
const LOCALES_DIR = path.resolve(here, '../../src/renderer/locales')
const REF = 'en'

function flattenKeys (obj, prefix = '') {
  const keys = []
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) keys.push(...flattenKeys(v, full))
    else keys.push(full)
  }
  return keys
}

function loadKeys (locale, ns) {
  return new Set(flattenKeys(JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, `${ns}.json`), 'utf8'))))
}

const locales = fs.readdirSync(LOCALES_DIR).filter((d) => fs.statSync(path.join(LOCALES_DIR, d)).isDirectory())
const namespaces = fs.readdirSync(path.join(LOCALES_DIR, REF)).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))

// Pre-existing translation debt this guard surfaced: the reclaim / storage-settings
// UI strings were added to en only and never translated. NEW keys must NOT join
// this list — that is exactly what the guard below enforces (it fails if any
// missing key is NOT in here). TODO: translate these and shrink the set to empty.
const KNOWN_MISSING = new Set([
  'storageSettings.reclaimable', 'storageSettings.reclaimableA11y', 'storageSettings.looseFiles',
  'storageSettings.perShare', 'storageSettings.aboutReclaimable', 'storageSettings.aboutReclaimableDismiss',
  'storageSettings.reclaimAction', 'reclaimSpace.titleConfirm', 'reclaimSpace.titleProgress',
  'reclaimSpace.body', 'reclaimSpace.confirmAction', 'reclaimSpace.running', 'reclaimSpace.done',
])

for (const ns of namespaces) {
  const ref = loadKeys(REF, ns)
  for (const loc of locales) {
    if (loc === REF) continue
    test(`i18n: ${loc}/${ns}.json introduces no NEW key drift vs ${REF}`, (t) => {
      const cur = loadKeys(loc, ns)
      const newMissing = [...ref].filter((k) => !cur.has(k) && !KNOWN_MISSING.has(k))
      const extra = [...cur].filter((k) => !ref.has(k))
      t.alike(newMissing, [], `NEW missing keys in ${loc}/${ns}: ${newMissing.join(', ') || 'none'}`)
      t.alike(extra, [], `extra keys in ${loc}/${ns}: ${extra.join(', ') || 'none'}`)
    })
  }
}
