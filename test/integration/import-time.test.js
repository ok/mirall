import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { spawn } from 'bare-subprocess'
import { trackTimers } from '../helpers/timers.js'

const here = path.dirname(import.meta.url.replace(/^file:\/\//, ''))
const shared = path.join(here, '..', '..', 'src', 'shared')

const walk = (dir, out = []) => {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) { if (name !== 'vendor') walk(p, out) } else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

// REGRESSION (LIFECYCLE-1d: importing the data layer must arm nothing. This catches what the
// static lint rule cannot — a module-level `createX()` whose body arms a timer — because the
// shim is installed before the imports run and counts what is actually alive afterwards.)
test('REGRESSION (LIFECYCLE-1d): importing every src/shared module creates zero timers', async (t) => {
  const timers = trackTimers()
  t.teardown(() => timers.restore())
  for (const file of walk(shared)) {
    try { await import(file) } catch (err) { t.fail(file + ' failed to import: ' + err.message) }
  }
  const armed = timers.intervals()
  t.is(armed.length, 0, 'no interval armed by import\n' + timers.describe(armed))
})

// The TDZ escape (lessons.md: a factory invoked during a circular import must not read its own
// module's consts). Each SCC member is imported FIRST in a fresh process — the order a single
// test process cannot reproduce is exactly the order that bit.
// The cycle is now {files, loose-overlay}: constructing the download engines in the overlay
// backend's _open cut the last edge into overlay-download.js, so it and overlay-backend.js are
// no longer in any cycle. The rest stay listed — importing them first must keep working.
const SCC = [
  'transfer/loose-overlay.js',
  'transfer/files.js',
  'transfer/backends/overlay/overlay-download.js',
  'transfer/backends/overlay/overlay-instance.js',
  'transfer/backends/overlay/overlay-backend.js',
  'transfer/backends/overlay/overlay-runtime.js',
  'transfer/backends/overlay/overlay-maintenance.js',
  'transfer/backends/overlay/stall-retry.js',
  'folders/publish-service.js',
  'folders/owned-folders.js',
  'folders/foreign-folders.js',
]

test('each import-cycle member can be imported first without a TDZ ReferenceError', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirall-import-first-'))
  t.teardown(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })
  for (const rel of SCC) {
    const entry = path.join(dir, rel.replace(/\//g, '-') + '.mjs')
    fs.writeFileSync(entry, `import('${path.join(shared, rel)}').then(() => Bare.exit(0), (e) => { console.error(e.stack); Bare.exit(1) })\n`)
    // Bare.argv[0] is the running bare binary.
    const code = await new Promise((resolve) => {
      const p = spawn(Bare.argv[0], [entry], { stdio: 'inherit' })
      p.on('exit', resolve)
    })
    t.is(code, 0, rel + ' imported first')
  }
})

// A cycle is not a style problem: a module in one is evaluated half-initialised when it is the
// entry, which is the TDZ class the ratchet above exists for. The list above is a ratchet of
// modules that WERE cyclic; this is the property itself, so a new cycle fails the moment it is
// written rather than the next time someone happens to import the wrong member first.
test('no module in the data layer sits in an import cycle', (t) => {
  const files = walk(shared)
  const rel = (p) => path.relative(shared, p).split(path.sep).join('/')
  const edges = new Map()
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8')
    const out = new Set()
    for (const m of src.matchAll(/^\s*(?:import|export)[^'"]*from\s*'(\.[^']+)'/gm)) {
      const target = path.resolve(path.dirname(file), m[1])
      if (files.includes(target)) out.add(rel(target))
    }
    edges.set(rel(file), out)
  }
  t.ok(edges.size > 100, `the scan read the data layer (${edges.size} modules) — an empty graph has no cycles`)

  // Tarjan, iterative: the graph is small but deep enough that recursion is not worth the risk.
  const index = new Map(); const low = new Map(); const onStack = new Set(); const stack = []
  const sccs = []; let counter = 0
  for (const root of edges.keys()) {
    if (index.has(root)) continue
    const work = [[root, 0]]
    while (work.length) {
      const frame = work[work.length - 1]
      const [node, childIndex] = frame
      if (childIndex === 0) { index.set(node, counter); low.set(node, counter); counter++; stack.push(node); onStack.add(node) }
      const children = [...(edges.get(node) ?? [])]
      if (childIndex < children.length) {
        frame[1]++
        const child = children[childIndex]
        if (!index.has(child)) work.push([child, 0])
        else if (onStack.has(child)) low.set(node, Math.min(low.get(node), index.get(child)))
        continue
      }
      if (low.get(node) === index.get(node)) {
        const group = []
        let popped
        do { popped = stack.pop(); onStack.delete(popped); group.push(popped) } while (popped !== node)
        if (group.length > 1) sccs.push(group.sort())
      }
      work.pop()
      if (work.length) {
        const parent = work[work.length - 1][0]
        low.set(parent, Math.min(low.get(parent), low.get(node)))
      }
    }
  }

  // The data layer carries no import cycle. Nothing belongs on this list: the way to keep it
  // empty is to point an upward edge at a leaf, never to record the loop here.
  const KNOWN = []
  t.alike(sccs.map((g) => g.join(' ↔ ')).sort(), [...KNOWN].sort(), 'no import cycle beyond the tracked ones')
})
