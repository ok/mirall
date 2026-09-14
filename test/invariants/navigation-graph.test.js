import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { transformSync } from 'esbuild'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ROUTER = path.join(root, 'src', 'renderer', 'ScreenRouter.tsx')

// TypeScript the Node runner cannot import directly. The module has no imports of its own, so it
// evaluates as-is.
function loadModule(relPath) {
  const { code } = transformSync(readFileSync(path.join(root, relPath), 'utf8'), { loader: 'ts', format: 'cjs' })
  const mod = { exports: {} }
  new Function('module', 'exports', code)(mod, mod.exports)
  return mod.exports
}

const { SCREENS, parentOf } = loadModule('src/renderer/shell/navigation.ts')

// The back targets a screen can remember. Every combination has to land somewhere: these are the
// two ends of each remembered range, so a target that cannot reach the root shows up here.
const TARGETS = [
  { preSettingsScreen: 'spaces', preAccountScreen: 'spaces', storageBackTarget: 'settings', activityLogBackTarget: 'account' },
  { preSettingsScreen: 'space-view', preAccountScreen: 'space-view', storageBackTarget: 'space-view', activityLogBackTarget: 'network-status' },
]

// Back has to terminate. A parent chain that loops means the user is stuck on a pair of screens
// with no way out to the home screen, which no amount of pressing Back would resolve.
test('every screen reaches the root by backing out, under every remembered target', (t) => {
  t.ok(SCREENS.length > 10, `${SCREENS.length} screens in the graph`)
  for (const targets of TARGETS) {
    for (const screen of SCREENS) {
      const seen = new Set([screen])
      let at = screen
      let parent = parentOf(at, targets)
      while (parent) {
        t.absent(seen.has(parent), `${screen}: back leads through ${parent} twice — the chain loops`)
        if (seen.has(parent)) break
        seen.add(parent)
        at = parent
        parent = parentOf(at, targets)
      }
      t.is(at, 'spaces', `${screen} backs out to the root`)
    }
  }
})

// The router's own exhaustiveness is a compile error (the `never` binding at the end of its switch),
// which this layer cannot run. What it CAN check is that the binding is still there: delete it and
// a screen with no branch becomes a blank window at runtime instead of a build failure.
test('the router still fails to compile on a screen it does not render', (t) => {
  const src = readFileSync(ROUTER, 'utf8')
  t.ok(/const \w+: never = currentScreen/.test(src),
    'ScreenRouter ends its switch on a never binding')
})
