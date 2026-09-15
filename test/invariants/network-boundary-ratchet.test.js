import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = path.join(here, '..', '..', 'src')
const networkDir = path.join(src, 'shared', 'network')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'vendor') walk(p, out) } else if (/\.(js|ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

const rel = (p) => path.relative(src, p).split(path.sep).join('/')

// A domain that asks the network a question imports the module that answers it, not the connection
// layer that happens to re-export it. Presence has its own module (presence-leases.js), the peer
// indexes theirs (swarm-registries.js), admission theirs (handshake-apply.js) — so nothing outside
// network/ needs swarm.js for anything but the Swarm subsystem itself.
test('only the worker composition root imports network/swarm.js', (t) => {
  const allowed = new Set(['worker/boot.js'])
  const offenders = []
  for (const file of walk(src)) {
    const r = rel(file)
    if (r.startsWith('shared/network/')) continue
    if (!/from '[^']*network\/swarm\.js'/.test(readFileSync(file, 'utf8'))) continue
    if (!allowed.has(r)) offenders.push(r)
  }
  t.alike(offenders.sort(), [], 'import the module that owns the answer, not the connection layer')
})

// swarm.js re-exported 46 names from five siblings, and every consumer learned the wrong address.
// The rule that replaces it: the root exports the subsystem and nothing else.
test('network/swarm.js re-exports nothing', (t) => {
  const source = readFileSync(path.join(networkDir, 'swarm.js'), 'utf8')
  t.absent(/^export \{[^}]*\} from/m.test(source), 'no re-export block')
  t.absent(/^export \* from/m.test(source), 'no star re-export')
})

// A collaborator wired at import time runs in every process that so much as imports the module,
// and no close() can reach what it armed. Wiring belongs in the subsystem's _open.
test('network modules wire their collaborators inside a lifecycle, not at import', (t) => {
  const offenders = []
  for (const file of walk(networkDir)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      // A call at column 0 is module scope; anything wired inside a function is indented.
      if (!/^init[A-Z]\w*\(/.test(line)) return
      offenders.push(`${rel(file)}:${i + 1}`)
    })
  }
  t.alike(offenders.sort(), [], 'move the init into the Subsystem _open that owns it')
})

// The root is a composition root. It grows when a responsibility is put back into it, which is the
// direction this split exists to prevent.
test('network/swarm.js stays a composition root', (t) => {
  const n = readFileSync(path.join(networkDir, 'swarm.js'), 'utf8').split('\n').length
  t.ok(n <= 210, `swarm.js is ${n} lines, ceiling 210 — the ceiling only falls`)
})
