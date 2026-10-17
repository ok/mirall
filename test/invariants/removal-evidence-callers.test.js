import test from 'brittle'
import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '../..')

// Removal evidence takes a space out of the backup loss check, so only the leave and join flows may
// write it: a leave, a pending join cancelled or denied, and a leave finished at boot. Every path that
// forgets a space record is one of those; the leftover sweep deletes data with no such action behind
// it, and it must never explain itself.
//
// Read as text, per this folder's rule: a guard scans src/** and imports nothing from it.
function sources(dir = path.join(ROOT, 'src')) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(full))
    else if (/\.(js|ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/')
const callers = (pattern) => sources().filter((file) => pattern.test(readFileSync(file, 'utf8'))).map(rel).sort()

test('only forgetting a space record writes removal evidence', (t) => {
  t.alike(callers(/\brecordRemoval\(/), ['src/shared/spaces/leave-records.js', 'src/shared/storage/removal-evidence.js'])
})

test('every path that forgets a space record is a leave or join flow', (t) => {
  t.alike(callers(/\b(forgetSpaceRecord|purgeSpace)\(/), [
    'src/shared/spaces/leave-records.js',
    'src/worker/ipc/membership.js',
    'src/worker/ipc/space-leave.js',
  ])
})

test('the leftover sweep never imports removal evidence', (t) => {
  t.alike(callers(/from '[^']*\/removal-evidence\.js'/), [
    'src/shared/spaces/leave-records.js',
    'src/shared/storage/backup/backup-run.js',
    'src/worker/ipc/diagnostics.js',
  ])
})
