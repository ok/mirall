import test from 'brittle'
import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/renderer')

// module-export-resolution covers shared, worker, main and preload. The renderer was the one runtime
// with no on-disk resolution guard, and it is the one where a path codemod is most dangerous: it
// writes '.js' specifiers that resolve to .ts/.tsx, so a repair pass that only tries '.js' concludes
// a live import is broken. One did, and rewrote 37 files to import the WORKER's ipc.js instead of
// the renderer's own — tsc passed, because the target is a real module with a matching export.
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(js|ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

const resolves = (p) => [p, p.replace(/\.js$/, '.ts'), p.replace(/\.js$/, '.tsx'), p.replace(/\.js$/, '.d.ts'),
  `${p}.ts`, `${p}.tsx`, `${p}.js`, path.join(p, 'index.ts'), path.join(p, 'index.js')].some(existsSync)

test('every relative specifier in the renderer resolves on disk', (t) => {
  const broken = []
  for (const file of walk(ROOT)) {
    const body = readFileSync(file, 'utf8')
    for (const m of body.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?['"](\.[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(file), m[1])
      if (!resolves(target)) broken.push(`${path.relative(ROOT, file)} -> ${m[1]}`)
    }
  }
  t.alike(broken.sort(), [], 'a renderer import names a file that is not there')
})
