import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
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

// The same rule one level up: the audit row's participant shapes. These were hand-written object
// literals at 52 sites and drifted five ways — some omitted `key` and `name`, one module shadowed
// the worker's own spaceRef with a second copy, and the worker kept three of them private so no
// other producer could reach them. audit-record.js builds them or nothing does.
const HAND_BUILT = [
  [/type:\s*ACTOR_TYPE\./, 'builds an actor literal instead of calling selfActor/peerActor/systemActor'],
  [/target:\s*\{\s*kind:/, 'builds a target literal instead of calling targetRef'],
  [/space:\s*\{\s*id:/, 'builds a space literal instead of calling spaceRef'],
]

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'vendor') walk(p, out) }
    else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

test('no module hand-builds an audit row participant', (t) => {
  const root = path.join(here, '..', '..', 'src')
  const files = [...walk(path.join(root, 'shared')), ...walk(path.join(root, 'worker'))]
    .filter((f) => !f.endsWith(path.join('audit', 'audit-record.js')))
  t.ok(files.length > 50, `walked ${files.length} data-layer modules`)

  for (const file of files) {
    const body = readFileSync(file, 'utf8')
    for (const [pattern, why] of HAND_BUILT) {
      t.absent(pattern.test(body), `${path.relative(root, file)} ${why}`)
    }
  }
})
