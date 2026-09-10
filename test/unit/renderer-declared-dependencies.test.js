import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import tsParser from '@typescript-eslint/parser'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(here, '..', '..')
const rendererDir = path.join(repoRoot, 'src', 'renderer')

function walk (dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'locales') walk(p, out) }
    else if (/\.(ts|tsx|js)$/.test(name)) out.push(p)
  }
  return out
}

// The package a bare specifier belongs to: '@scope/name/sub' -> '@scope/name', 'react-dom/client' -> 'react-dom'.
function packageOf (specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function bareSpecifiers (source) {
  const ast = tsParser.parse(source, { ecmaFeatures: { jsx: true }, sourceType: 'module' })
  const found = []
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(visit); return }
    const carriesSource = node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' ||
      node.type === 'ExportAllDeclaration' || node.type === 'ImportExpression'
    if (carriesSource && node.source?.type === 'Literal' && typeof node.source.value === 'string') {
      const value = node.source.value
      if (!value.startsWith('.') && !value.startsWith('/')) found.push(value)
    }
    for (const key of Object.keys(node)) visit(node[key])
  }
  visit(ast.body)
  return found
}

// Every package the renderer names must be declared in package.json. A specifier that resolves only
// because some other package hoisted it into node_modules is one dependency bump away from a build
// that fails with no lockfile signal — `import type` included, since esbuild strips those but tsc
// does not.
test('every bare import in src/renderer names a declared dependency', (t) => {
  t.alike(bareSpecifiers("import type { Node } from '@react-types/shared'\n").map(packageOf), ['@react-types/shared'], 'a type-only import counts')
  t.alike(bareSpecifiers("import { createRoot } from 'react-dom/client'\n").map(packageOf), ['react-dom'], 'a subpath maps to its package')
  t.alike(bareSpecifiers("import Icon from '../primitives/Icon.js'\n").map(packageOf), [], 'a relative import is not a dependency')
  t.alike(bareSpecifiers("const m = await import('marked')\n").map(packageOf), ['marked'], 'a dynamic import counts')

  const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})])

  const files = walk(rendererDir)
  t.ok(files.length > 100, 'src/renderer was actually walked')

  const undeclared = []
  for (const file of files) {
    for (const specifier of bareSpecifiers(readFileSync(file, 'utf8'))) {
      const pkg = packageOf(specifier)
      if (!declared.has(pkg)) undeclared.push(`${path.relative(repoRoot, file)}: ${specifier}`)
    }
  }
  t.alike(undeclared, [], 'no renderer import relies on a transitively hoisted package')
})
