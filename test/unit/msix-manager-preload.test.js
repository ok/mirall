import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

// The real bug — `Cannot find module 'msix-manager'` thrown by
// pear-runtime-updater.applyUpdate()'s lazy require — only manifests in the
// real environment: Electron + asar + Windows MSIX + the wrapWithNoAsar
// window. There is no in-process surface to reproduce it from a unit test
// (no Electron, no asar, no win32 here). What we CAN protect against is the
// regression vector: someone refactoring src/main/main.js removing the
// "warm the require cache before getPear() opens the noAsar window" hop,
// reintroducing the race. So this test pins the structural invariant in
// preloadAsarCache(): on win32 it must `require('msix-manager')`, and that
// preload must live INSIDE preloadAsarCache (called before getPear()), not
// somewhere lazier that could run after wrapWithNoAsar is installed.

const here = path.dirname(fileURLToPath(import.meta.url))
const mainSrc = readFileSync(path.join(here, '..', '..', 'src', 'main', 'main.js'), 'utf8')

function preloadAsarCacheBody() {
  const m = mainSrc.match(/function preloadAsarCache\s*\(\)\s*\{([\s\S]*?)\n\}/)
  return m ? m[1] : null
}

test('REGRESSION (FIX-2: Windows OTA "Cannot find module msix-manager"): preloadAsarCache warms msix-manager on win32 before the noAsar window opens', (t) => {
  const body = preloadAsarCacheBody()
  t.ok(body, 'preloadAsarCache() exists in src/main/main.js')

  // Must warm msix-manager from a win32-gated branch so its Module._cache
  // entry is in place before wrapWithNoAsar (see getPear()) flips noAsar=true
  // around applyUpdate's lazy require. Crucially, the preload must use the
  // pear-runtime-updater module's OWN require context (Module.createRequire
  // on the updater's index.js) so Node's pathCache key + parent.paths match
  // the later resolution — preloading from main.js's context populates a
  // different pathCache key and won't help.
  const winBlock = body.match(/if\s*\(\s*isWindows\s*\)\s*\{([\s\S]*?)\n\s*\}/)
  t.ok(winBlock, 'preloadAsarCache has a `if (isWindows) { … }` block')
  const block = winBlock ? winBlock[1] : ''
  t.ok(/Module\.createRequire\([^)]*updaterIndex[^)]*\)\s*\(\s*['"]msix-manager['"]\s*\)/.test(block),
    'preload calls Module.createRequire(updaterIndex)(\'msix-manager\') — not a context-free require')
  t.ok(/require\.resolve\(\s*['"]pear-runtime-updater['"]\s*\)/.test(block),
    'updaterIndex is derived from `require.resolve(\'pear-runtime-updater\')`')

  // preloadAsarCache itself must be invoked from the app's whenReady handler
  // — that's the only entry point that runs early enough to beat any later
  // getPear() call (which installs the wrapWithNoAsar wrappers). getPear() is
  // called lazily from worker spawn paths, not whenReady itself, so we don't
  // pin its ordering here; preloadAsarCache living in whenReady is sufficient.
  const whenReady = mainSrc.match(/app\.whenReady\(\)\.then\(async\s*\([^)]*\)\s*=>\s*\{[\s\S]{0,4000}/)
  t.ok(whenReady && whenReady[0].includes('preloadAsarCache()'), 'preloadAsarCache() is invoked from app.whenReady')
})
