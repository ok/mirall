import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { KINDS } from '../../src/shared/contract/audit-kinds.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const TWIN = path.join(here, '..', '..', 'src', 'renderer', 'auditKinds.ts')

// This test used to diff two hand-maintained lists. The vocabulary now lives once in the contract
// package and the renderer re-exports it, so the divergence it watched for cannot occur — what is
// worth guarding instead is that nobody reintroduces the twin.
test('the renderer re-exports the audit vocabulary instead of mirroring it', (t) => {
  const src = readFileSync(TWIN, 'utf8')
  t.ok(/from '\.\.\/shared\/contract\/audit-kinds\.js'/.test(src), 'imported from the contract')
  const literals = src.match(/'[a-z_]+(?:\.[a-z_]+)+'/g) || []
  t.alike(literals, [], 'no kind names are re-listed here — that list is what used to drift')
})

test('every kind has a label and a sentence key in the English catalogue', (t) => {
  const common = JSON.parse(readFileSync(path.join(here, '..', '..', 'src', 'renderer', 'locales', 'en', 'common.json'), 'utf8'))
  for (const kind of Object.keys(KINDS)) {
    t.ok(common.activityLog?.kind?.[kind], 'sentence copy for ' + kind)
    t.ok(common.activityLog?.kindLabel?.[kind], 'search label for ' + kind)
  }
})
