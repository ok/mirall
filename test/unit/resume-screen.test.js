import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { transformSync } from 'esbuild'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// TypeScript the Node runner cannot import directly, and a module with no imports of its own, so
// it evaluates as-is — same shape as the navigation-graph invariant.
function loadModule(storage) {
  const src = readFileSync(path.join(root, 'src/renderer/shell/resume-screen.ts'), 'utf8')
  const { code } = transformSync(src, { loader: 'ts', format: 'cjs' })
  const mod = { exports: {} }
  new Function('module', 'exports', 'sessionStorage', code)(mod, mod.exports, storage)
  return mod.exports
}

function memoryStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    size: () => map.size,
  }
}

function throwingStorage() {
  return {
    getItem() { throw new Error('storage disabled') },
    setItem() { throw new Error('storage disabled') },
    removeItem() { throw new Error('storage disabled') },
  }
}

// REGRESSION (FIX-1: applying a relay restarted the worker, and the reload that followed dropped
// the user on the space list instead of the screen they changed the setting on).
test('REGRESSION (FIX-1): a parked screen is what the next boot resumes on', (t) => {
  const storage = memoryStorage()
  const { rememberScreen, takeRememberedScreen } = loadModule(storage)
  rememberScreen('network-settings')
  t.is(takeRememberedScreen(), 'network-settings')
})

test('a boot with nothing parked starts at the root', (t) => {
  const { takeRememberedScreen } = loadModule(memoryStorage())
  t.is(takeRememberedScreen(), null)
})

test('taking the screen clears it, so a later reload does not resume again', (t) => {
  const storage = memoryStorage()
  const { rememberScreen, takeRememberedScreen } = loadModule(storage)
  rememberScreen('network-settings')
  takeRememberedScreen()
  t.is(takeRememberedScreen(), null, 'second boot starts at the root')
  t.is(storage.size(), 0, 'nothing left behind in storage')
})

// The value comes back out of storage, where anything could have written it.
test('a screen name that is not resumable is ignored', (t) => {
  const storage = memoryStorage()
  const { takeRememberedScreen } = loadModule(storage)
  storage.setItem('mirall:resume-screen', 'space-view')
  t.is(takeRememberedScreen(), null)
})

test('storage that throws costs the resume, not the boot', (t) => {
  const { rememberScreen, takeRememberedScreen } = loadModule(throwingStorage())
  t.execution(() => rememberScreen('network-settings'))
  t.is(takeRememberedScreen(), null)
})
