import test from 'brittle'
import { existsSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { KINDS } from '../../src/shared/contract/audit-kinds.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const renderer = path.join(here, '..', '..', 'src', 'renderer')

// This test used to diff two hand-maintained lists, then guarded a re-export shim. The vocabulary
// lives once in the contract package and the one renderer consumer imports it directly — what is
// worth guarding is that nobody reintroduces a twin.
test('the renderer holds no audit-kind twin', (t) => {
  t.absent(existsSync(path.join(renderer, 'auditKinds.ts')), 'the shim is gone')
  const screen = readFileSync(path.join(renderer, 'screens', 'ActivityLog.tsx'), 'utf8')
  t.ok(/from '\.\.\/\.\.\/shared\/contract\/audit-kinds\.js'/.test(screen), 'ActivityLog imports the contract')
})

test('every kind has a label and a sentence key in the English catalogue', (t) => {
  const common = JSON.parse(readFileSync(path.join(here, '..', '..', 'src', 'renderer', 'locales', 'en', 'common.json'), 'utf8'))
  for (const kind of Object.keys(KINDS)) {
    t.ok(common.activityLog?.kind?.[kind], 'sentence copy for ' + kind)
    t.ok(common.activityLog?.kindLabel?.[kind], 'search label for ' + kind)
  }
})
