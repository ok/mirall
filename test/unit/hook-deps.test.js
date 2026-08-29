import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const roots = ['shared', 'worker'].map((d) => path.join(here, '..', '..', 'src', d))

function walk (dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'vendor') walk(p, out) } else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

// REGRESSION (LIFECYCLE-3d: eleven nullable hook slots, each with exactly one caller, each invoked
// as hook?.() — so an unset one was a silent no-op that no test could observe. As constructor deps
// validated by require(), a missing one throws at boot with the subsystem's name.)
const RETIRED_SETTERS = [
  'setMembershipControlHandler',
  'setConnectionAttachHook',
  'setOverlayReconnectHook',
  'setRevokeServesForSpaceHook',
  'setStalledOwnersHook',
  'setContentAttachHook',
  'setContentResumeHook',
  'setMembershipRevokedHook',
]

test('REGRESSION (LIFECYCLE-3d): the swarm and registry hook setters are gone from src/', (t) => {
  for (const file of roots.flatMap((r) => walk(r))) {
    const src = readFileSync(file, 'utf8')
    for (const name of RETIRED_SETTERS) {
      t.absent(src.includes(name), path.relative(process.cwd(), file) + ' references ' + name)
    }
  }
})

// require() is what turns a missing collaborator into a boot failure. A subsystem that reads
// this.deps.x without requiring it would still fail the old way — silently.
test('every subsystem requires the collaborators it reads', (t) => {
  for (const file of roots.flatMap((r) => walk(r))) {
    const src = readFileSync(file, 'utf8')
    if (!src.includes('extends Subsystem')) continue
    for (const match of src.matchAll(/class (\w+) extends Subsystem \{([\s\S]*?)\n\}/g)) {
      const [, name, body] = match
      // Every read, with the two characters that follow it, so one defensive read of a name
      // cannot exempt a bare read of the same name elsewhere in the class.
      const reads = [...body.matchAll(/this\.deps\.(\w+)(?=([\s\S]{0,2}))/g)]
      if (reads.length === 0) continue
      const required = new Set(
        [...body.matchAll(/this\.require\(([^)]*)\)/g)]
          .flatMap((m) => m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')))
          .filter(Boolean),
      )
      for (const [, dep, next] of reads) {
        // This read is defensive — `?.`, `??`, `&&`, or a closing paren from `if (x)` — so the
        // collaborator is legitimately optional. A bare read must be required, or a missing one
        // is the silent no-op this test exists to prevent.
        if (next === '?.' || next === ' ?' || next === ' &' || next === ')' || next === ') ') continue
        t.ok(required.has(dep), name + ' reads this.deps.' + dep + ' bare without requiring it')
      }
    }
  }
})
