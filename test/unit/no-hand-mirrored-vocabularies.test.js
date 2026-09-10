import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = (rel) => readFileSync(path.join(here, '..', '..', 'src', rel), 'utf8')

// Each of these files once held its own copy of a rule the contract package now owns, kept in step
// by a comment asking the next contributor to remember. The invite envelope proves what that is
// worth: it drifted by four fields. The guard is that these import the contract's declaration
// rather than re-declare it.
const MIRRORED = [
  ['shared/audit/audit-record.js', /NAME_MAX\s*=\s*\d/],
  ['shared/identity-limits.js', /NAME_MAX\s*=\s*\d|AVATAR_MAX_BYTES\s*=\s*\d/],
]

test('no module re-declares a vocabulary the contract package owns', (t) => {
  for (const [file, pattern] of MIRRORED) {
    t.absent(pattern.test(src(file)), `${file} imports rather than re-declares`)
  }
})

test('every mirrored module points at the contract package', (t) => {
  for (const [file] of MIRRORED) {
    t.ok(/from '[^']*contract\/[a-z-]+\.js'/.test(src(file)), `${file} imports from the contract`)
  }
})
