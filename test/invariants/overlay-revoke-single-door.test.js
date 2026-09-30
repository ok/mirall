import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel) => readFileSync(path.join(root, rel), 'utf8')
const rel = (p) => path.relative(root, p).split(path.sep).join('/')
const RUNTIME = 'src/shared/transfer/backends/overlay/overlay-runtime.js'
const SPACE_LEAVE = 'src/worker/ipc/space-leave.js'
const DOOR_FNS = ['revokeServesForSpace', 'bumpServeEpoch']

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(js|mjs|ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

// Static `import { … } from`, dynamic `const { … } = await import(…)`, and namespace imports of
// overlay-instance.js; a namespace import reaches every export, so it counts as importing both.
function instanceImports(src) {
  const names = []
  const spec = String.raw`['"][^'"]*overlay-instance\.js['"]`
  for (const m of src.matchAll(new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s*${spec}`, 'g'))) names.push(m[1])
  for (const m of src.matchAll(new RegExp(String.raw`\{([^}]*)\}\s*=\s*await\s+import\(\s*${spec}\s*\)`, 'g'))) names.push(m[1])
  if (new RegExp(String.raw`import\s*\*\s*as\s+\w+\s+from\s*${spec}`).test(src)) names.push(DOOR_FNS.join(','))
  return names.join(',').split(',').map((n) => n.trim().split(/\s+as\s+|\s*:\s*/)[0]).filter(Boolean)
}

// A serve revoke without the epoch bump leaves cached grants trusted past a membership change, so
// the pair has one door: OverlayBackend.revokeServesForSpace, which does both in order.
test('only the overlay runtime imports the serve revoke and the epoch bump from the instance', (t) => {
  const importers = walk(path.join(root, 'src'))
    .filter((p) => instanceImports(readFileSync(p, 'utf8')).some((n) => DOOR_FNS.includes(n)))
    .map(rel)
  t.alike(importers, [RUNTIME], 'overlay-runtime.js is the one importer, and it is found')
})

test('space:leave revokes serves through the overlay backend exactly once', (t) => {
  const src = read(SPACE_LEAVE)
  t.is(src.split('overlayBackend?.revokeServesForSpace(').length - 1, 1, 'one call through the backend')
  t.absent(/\bbumpServeEpoch\s*\(/.test(src), 'and no hand-rolled epoch bump beside it')
})
