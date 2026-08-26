import test from 'brittle'
import { build } from 'esbuild'
import { fileURLToPath } from 'url'

// The renderer entry (src/renderer/main.tsx) loads @axe-core/react for dev-time
// accessibility instrumentation. It is gated behind `isDev()` and dynamically
// imported, but esbuild emits a single bundle (no --splitting), so the gate only
// stops it from *running* in production — all ~600 KB of axe-core still shipped
// in main.js (≈43% of the bundle). The fix introduces a compile-time `__DEV__`
// flag (--define:__DEV__=false in build:js, =true in dev:js) and guards the
// bootstrap with `if (__DEV__ && ...)`, so the dev branch — and its
// `import('@axe-core/react')` — is dead-code-eliminated from production builds.
//
// These tests bundle the real entry both ways and lock the contract: axe-core is
// absent when __DEV__=false and present when __DEV__=true. 'color-contrast' is an
// axe-core rule id that appears nowhere else in the graph, so it is a reliable
// fingerprint for "axe is in this bundle".

const entry = fileURLToPath(new URL('../../src/renderer/main.tsx', import.meta.url))

async function bundle (dev) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    jsx: 'automatic',
    minify: true,
    define: { __DEV__: String(dev) },
    loader: { '.png': 'file', '.jpg': 'file', '.svg': 'file' },
    // outdir lets the `file` loader resolve asset paths; write:false keeps it
    // in memory so nothing is emitted. Pick the JS output (assets are separate).
    outdir: 'esbuild-axe-test-out',
    write: false,
  })
  return result.outputFiles.find((f) => f.path.endsWith('.js')).text
}

test('REGRESSION (FIX-AXE-1): production bundle (__DEV__=false) strips axe-core', async (t) => {
  const out = await bundle(false)
  t.absent(out.includes('@axe-core'), 'no @axe-core module reference in prod bundle')
  t.absent(out.includes('color-contrast'), 'no axe-core rule ids in prod bundle')
  // A backstop for the two string checks above, not a size budget: axe-core adds ~616KB, so any
  // inclusion lands near the dev bundle's ~1.6MB and blows past this by a wide margin. The number
  // was 1_000_000 with ~200 bytes of headroom, which quietly made it the budget for UI copy — the
  // five statically-bundled locales are ~27% of the bundle, so a feature adding a few dozen strings
  // in five languages failed a test about axe-core. Raised to keep the axe margin while letting
  // copy grow. Lazy-loading the non-active locales is still the real fix for the 27%.
  t.ok(out.length < 1_100_000, `prod bundle is small without axe-core (${out.length} bytes)`)
})

test('FIX-AXE-1 control: dev bundle (__DEV__=true) still ships axe-core', async (t) => {
  const out = await bundle(true)
  t.ok(out.includes('color-contrast'), 'axe-core present in dev bundle')
  t.ok(out.length > 1_200_000, `dev bundle is large with axe-core (${out.length} bytes)`)
  // The prod threshold above is only meaningful while it sits well below an axe-carrying bundle.
  t.ok(out.length - 1_100_000 > 400_000, 'the prod backstop still has a wide margin below axe-core')
})
