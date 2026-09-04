import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { preloadEntrypoints, entrypointFor } from '../../src/main/worker-entrypoints.js'
import { MAIN_WORKER_SPEC, WORKER_SPECS } from '../../src/shared/contract/workers.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(here, '..', '..')

// REGRESSION (FIX-H5-1: a specifier that missed the allowlist fell through to
// `require.resolve(path.join(__dirname, '..', '..', specifier))`, so any string the renderer handed
// pear:startWorker became a path this process resolved and pear.run() executed — with the bootstrap
// frame, which carries identityKEK. Refusing BEFORE resolution is the property, so the injected
// resolver doubles as the assertion.)
test('REGRESSION (FIX-H5-1): a specifier outside the allowlist is refused instead of resolved', (t) => {
  const resolved = []
  // `entrypoints` is module state shared with every other test in this process, and the injected
  // resolver fills it with paths require.resolve never returned. Put the real ones back.
  t.teardown(() => preloadEntrypoints(REPO))
  preloadEntrypoints(REPO, (p) => { resolved.push(p); return p })
  const afterPreload = resolved.length

  t.is(entrypointFor('/src/worker/main.js'), path.join(REPO, '/src/worker/main.js'), 'the declared spec resolves')

  for (const bad of ['/src/renderer/main.tsx', '../../../tmp/evil.js', '/etc/passwd', '']) {
    t.exception(() => entrypointFor(bad), `'${bad}' is refused`)
  }
  t.is(resolved.length, afterPreload, 'and none of them was ever resolved')
})

// REGRESSION (FIX-H5-2: the fallthrough itself. A ratchet rather than a behavioural test, because
// getWorker cannot be imported — main.js requires electron at module top.)
test('REGRESSION (FIX-H5-2): main no longer resolves an arbitrary specifier', (t) => {
  const src = readFileSync(path.join(REPO, 'src', 'main', 'main.js'), 'utf8')
  t.absent(/require\.resolve\(path\.join\(__dirname, '\.\.', '\.\.', specifier\)\)/.test(src),
    'the spawn fallthrough is gone')
})

test('the allowlist is the contract WORKER_SPECS', (t) => {
  const resolved = []
  t.teardown(() => preloadEntrypoints(REPO))
  preloadEntrypoints(REPO, (p) => { resolved.push(p); return p })
  t.alike(resolved, WORKER_SPECS.map((spec) => path.join(REPO, spec)))
})

// The sandboxed preload cannot import the contract (its `require` resolves only Electron builtins),
// so the literal there is duplication the sandbox forces. This is the price of admission.
test('preload asks only for a declared specifier', (t) => {
  const src = readFileSync(path.join(REPO, 'src', 'preload', 'preload.js'), 'utf8')
  const decl = src.match(/const WORKER_SPECS = new Set\(\[([^\]]*)\]\)/)
  t.ok(decl, 'preload declares its own allowlist')
  const specs = [...decl[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  t.alike(specs.sort(), [...WORKER_SPECS].sort(), 'and it matches the contract')
})

// The renderer used to take WORKER_SPECS[0]. An allowlist is a set, so position means nothing:
// adding a second entry ahead of the main worker would have repointed the renderer's entire IPC
// channel with every gate still green. It names the worker now, and the contract derives the
// allowlist from that name.
test('the renderer names its worker through the contract, not by position', (t) => {
  const src = readFileSync(path.join(REPO, 'src', 'renderer', 'ipc.ts'), 'utf8')
  t.ok(/const WORKER_SPEC = MAIN_WORKER_SPEC/.test(src), 'WORKER_SPEC is the named main worker')
  t.absent(/WORKER_SPECS\s*\[/.test(src), 'and nothing indexes the allowlist')
  // Any quote style: the old check only matched single quotes, so a double-quoted literal passed.
  t.absent(/['"`]\/src\/worker\//.test(src), 'no literal specifier is left behind')
  t.is(WORKER_SPECS[0], MAIN_WORKER_SPEC, 'the allowlist is derived from the name')
})

// preloadAsarCache() walks assets/ with readdirSync and has no catch, so an ENOENT there (a source
// checkout with no assets/dist) aborted the rest of the function. When preloadEntrypoints ran last,
// that left the allowlist EMPTY — and since the allowlist is now the only thing pear:startWorker
// resolves against, main would refuse to spawn its own declared worker.
test('the allowlist is resolved before anything in boot that can throw', (t) => {
  const src = readFileSync(path.join(REPO, 'src', 'main', 'main.js'), 'utf8')
  const body = src.slice(src.indexOf('function preloadAsarCache'))
  const preload = body.indexOf('preloadEntrypoints(')
  const walk = body.indexOf('walk(uiRoot)')
  t.ok(preload !== -1 && walk !== -1, 'found both')
  t.ok(preload < walk, 'the entrypoints are resolved first')
})
