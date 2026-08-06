import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { KINDS } from '../../src/shared/audit/audit-kinds.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const TWIN = path.join(here, '..', '..', 'src', 'renderer', 'auditKinds.ts')

// The renderer cannot import worker data-layer code, so AUDIT_KINDS is a hand-maintained twin.
// Divergence is silent at runtime — a missing kind just stops matching in locale search — so it
// is caught here instead.
function twinKinds () {
  const src = readFileSync(TWIN, 'utf8')
  return src.match(/'([a-z_]+(?:\.[a-z_]+)+)'/g).map((s) => s.slice(1, -1))
}

test('the renderer kind list matches the worker vocabulary exactly', (t) => {
  t.alike(twinKinds().sort(), Object.keys(KINDS).sort(),
    'src/renderer/auditKinds.ts and src/shared/audit/audit-kinds.js must stay in sync')
})

test('every kind has a label and a sentence key in the English catalogue', (t) => {
  const common = JSON.parse(readFileSync(path.join(here, '..', '..', 'src', 'renderer', 'locales', 'en', 'common.json'), 'utf8'))
  for (const kind of Object.keys(KINDS)) {
    t.ok(common.activityLog?.kind?.[kind], 'sentence copy for ' + kind)
    t.ok(common.activityLog?.kindLabel?.[kind], 'search label for ' + kind)
  }
})
