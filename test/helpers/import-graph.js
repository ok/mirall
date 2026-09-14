import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const SKIP_DIRS = new Set(['node_modules', 'dist', 'vendor', 'locales', '.git'])

// Static relative imports only. A dynamic import() defers the edge to call time, so it cannot close
// a load-time cycle; `import type` is erased before it runs and cannot either.
const EDGE = /^\s*(?:import|export)\s+(?!type\s)(?:[^'"]*?\sfrom\s+)?['"](\.[^'"]+)['"]/gm

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(js|ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

// The renderer writes '.js' specifiers that the bundler resolves to '.ts'/'.tsx'. A declaration
// file is not a runtime edge, so it is never a resolution target here.
function resolve(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec)
  const candidates = [base]
  if (base.endsWith('.js')) candidates.push(base.slice(0, -3) + '.ts', base.slice(0, -3) + '.tsx')
  candidates.push(base + '.js', base + '.ts', base + '.tsx', path.join(base, 'index.ts'), path.join(base, 'index.js'))
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile() && !c.endsWith('.d.ts')) return c
  }
  return null
}

export function buildGraph(dirs) {
  const files = dirs.flatMap((d) => walk(path.join(REPO, d)))
  const known = new Set(files)
  const graph = new Map()
  for (const file of files) {
    const deps = new Set()
    for (const m of readFileSync(file, 'utf8').matchAll(EDGE)) {
      const target = resolve(file, m[1])
      if (target && known.has(target) && target !== file) deps.add(target)
    }
    graph.set(file, deps)
  }
  return graph
}

// Every elementary cycle would be exponential to enumerate; one representative cycle per
// strongly-connected component is what a reader needs to fix it.
export function findCycles(dirs) {
  const graph = buildGraph(dirs)
  const cycles = []
  const state = new Map()
  const stack = []

  function visit(node) {
    state.set(node, 'open')
    stack.push(node)
    for (const dep of graph.get(node) ?? []) {
      if (state.get(dep) === 'open') {
        const from = stack.indexOf(dep)
        cycles.push(stack.slice(from).map((f) => path.relative(REPO, f)))
      } else if (!state.has(dep)) {
        visit(dep)
      }
    }
    stack.pop()
    state.set(node, 'done')
  }

  for (const node of graph.keys()) if (!state.has(node)) visit(node)
  return cycles
}
