import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')
const preloadPath = path.join(root, 'src', 'preload', 'preload.js')
const dtsPath = path.join(root, 'src', 'renderer', 'global.d.ts')

// The renderer's ONLY view of the preload bridge is global.d.ts, and nothing compares the two.
// preload.js is plain JS outside tsconfig's include, so TypeScript checks every call site against a
// declaration that could be describing a method the bridge does not have. The failure mode is not a
// type error — it is `window.bridge.foo is not a function` at runtime, in a sandboxed renderer, on
// whichever platform happens to reach that branch. That is the same hole
// contract-declarations.test.js measured for the contract package, on a much bigger surface.
//
// The preload cannot import the contract package to close this structurally: it runs with
// sandbox: true, which gives it a restricted require, and it ships unbundled. Bundling it is the
// option that would; until someone takes it, this test is the substitute.
//
// Parsed, not imported: preload.js calls contextBridge.exposeInMainWorld at module scope and
// requires('electron'), so it cannot be loaded under brittle-node. The key set is what matters and
// it is unambiguous in the source.

// Both extractors key on INDENTATION rather than on brace/paren depth: the values here are arrow
// functions full of parens and strings that themselves contain braces, and a depth counter walks
// straight into them. A top-level member of either surface sits at exactly two spaces; anything
// nested sits deeper and is that member's own business.
const atTopIndent = (body) => [...new Set(
  [...body.matchAll(/^ {2}([A-Za-z_$][\w$]*)\s*[:(]/gm)].map((m) => m[1]),
)].sort()

// The object literal passed to exposeInMainWorld, bounded the same way as the interface below.
// Slicing to end-of-file worked only because the call happens to be the last statement in the
// file: anything appended after it — a second exposeInMainWorld, a helper object literal — would
// have folded its keys into this surface. `\n})` closes the CALL and nothing inside it: a nested
// object closes at `  },` and a multi-line arrow at `  }),`, both indented.
function topLevelKeysOfExposedBridge (src) {
  const open = src.indexOf("exposeInMainWorld('bridge', {")
  if (open < 0) return []
  const close = src.indexOf('\n})', open)
  return atTopIndent(src.slice(open, close < 0 ? src.length : close))
}

// The body of `interface MirallBridge` — a call signature `name(...)` or a property `name:`.
function membersOfMirallBridge (src) {
  const open = src.indexOf('interface MirallBridge')
  if (open < 0) return []
  const close = src.indexOf('\n}', open)
  return atTopIndent(src.slice(open, close < 0 ? src.length : close))
}

test('the preload bridge and global.d.ts declare the same members', (t) => {
  const exposed = topLevelKeysOfExposedBridge(readFileSync(preloadPath, 'utf8'))
  const declared = membersOfMirallBridge(readFileSync(dtsPath, 'utf8'))

  t.ok(exposed.length > 40, `the extractor found a real surface (${exposed.length} keys)`)
  t.is(exposed.length, declared.length, 'the surface has not silently grown or shrunk on one side')
  t.alike(exposed, declared, 'every exposed key is declared, and every declared member is exposed')
})

// A regex that stops matching would make the test above vacuously green — two empty lists are
// alike. These feed each extractor a fixture with a known shape and assert it reads it, and a
// fixture with a member removed and assert the comparison notices.
test('the extractors would actually catch a divergence', (t) => {
  const preloadFixture = [
    "const { contextBridge } = require('electron')",
    "contextBridge.exposeInMainWorld('bridge', {",
    '  alpha: () => 1,',
    '  beta: (x) => ({ nested: x }),',
    '  gamma: {',
    '    subscribe: (fn) => fn,',
    '  },',
    '})',
  ].join('\n')
  t.alike(topLevelKeysOfExposedBridge(preloadFixture), ['alpha', 'beta', 'gamma'],
    'top-indent keys only — the nested subscribe is gamma\'s business, not the bridge\'s')

  // The bound, asserted: whatever follows the call is not part of the bridge. Without it the
  // extractor reported `delta` and the parity comparison failed on a member nobody exposed.
  const withTrailer = preloadFixture + '\n\nconst helpers = {\n  delta: () => 2,\n}\n'
  t.alike(topLevelKeysOfExposedBridge(withTrailer), ['alpha', 'beta', 'gamma'],
    'a statement appended after the call is not folded into the bridge surface')

  const dtsFixture = [
    'export interface MirallBridge {',
    '  alpha(): number',
    '  beta(x: string): { nested: string }',
    '  gamma: {',
    '    subscribe(fn: () => void): () => void',
    '  }',
    '}',
  ].join('\n')
  t.alike(membersOfMirallBridge(dtsFixture), ['alpha', 'beta', 'gamma'], 'and the same three on the declared side')

  const dropped = dtsFixture.replace('  beta(x: string): { nested: string }\n', '')
  t.alike(membersOfMirallBridge(dropped), ['alpha', 'gamma'], 'a removed declaration is seen as removed')
  t.absent(
    JSON.stringify(topLevelKeysOfExposedBridge(preloadFixture)) === JSON.stringify(membersOfMirallBridge(dropped)),
    'so a one-sided change fails the comparison rather than passing on two empty lists',
  )
})
