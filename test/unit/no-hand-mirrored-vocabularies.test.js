import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = (rel) => readFileSync(path.join(here, '..', '..', 'src', rel), 'utf8')

// Each of these files once held its own copy of a rule the contract package now owns, kept in step
// by a comment asking the next contributor to remember. The invite envelope proves what that is
// worth: it drifted by four fields. A re-export cannot drift, so the guard is that these stay
// re-exports rather than that their contents keep matching.
const MIRRORED = [
  ['renderer/invite-envelope.ts', /HEX64|NAME_MAX|b64url|btoa|atob/],
  ['renderer/decoration-key.js', /shareId \+ ':'/],
  ['shared/transfer/decoration-key.js', /shareId \+ ':'/],
  ['shared/invite-envelope.js', /HEX64\s*=|b64url|btoa|atob/],
  ['shared/audit/audit-record.js', /NAME_MAX\s*=\s*\d/],
]

test('no module re-declares a vocabulary the contract package owns', (t) => {
  for (const [file, pattern] of MIRRORED) {
    t.absent(pattern.test(src(file)), `${file} re-exports rather than re-declares`)
  }
})

test('every mirrored module points at the contract package', (t) => {
  for (const [file] of MIRRORED) {
    t.ok(/from '[^']*contract\/[a-z-]+\.js'/.test(src(file)), `${file} imports from the contract`)
  }
})
