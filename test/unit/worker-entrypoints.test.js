import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { preloadEntrypoints, entrypointFor } from '../../src/main/worker-entrypoints.js'
import { WORKER_SPECS } from '../../src/shared/contract/workers.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(here, '..', '..')

// REGRESSION (FIX-H5-1: a specifier that missed the allowlist fell through to
// `require.resolve(path.join(__dirname, '..', '..', specifier))`, so any string the renderer handed
// pear:startWorker became a path this process resolved and pear.run() executed — with the bootstrap
// frame, which carries identityKEK. Refusing BEFORE resolution is the property, so the injected
// resolver doubles as the assertion.)
test('REGRESSION (FIX-H5-1): a specifier outside the allowlist is refused instead of resolved', (t) => {
  const resolved = []
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

test('the renderer names its worker through the contract', (t) => {
  const src = readFileSync(path.join(REPO, 'src', 'renderer', 'ipc.ts'), 'utf8')
  t.ok(/const WORKER_SPEC = WORKER_SPECS\[0\]/.test(src), 'WORKER_SPEC derives from WORKER_SPECS')
  t.absent(/'\/src\/worker\//.test(src), 'and no literal specifier is left behind')
})
