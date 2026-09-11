import test from 'brittle'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { Linter } from 'eslint'
import tsParser from '@typescript-eslint/parser'
import { rendererContractOnlyImports } from '../../eslint.config.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const rendererDir = path.join(here, '..', '..', 'src', 'renderer')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'locales') walk(p, out) }
    else if (/\.(ts|tsx|js)$/.test(name)) out.push(p)
  }
  return out
}

function verify(linter, source, filename) {
  return linter.verify(source, {
    files: ['**/*.ts', '**/*.tsx', '**/*.js'],
    languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: { 'no-restricted-imports': ['error', { patterns: rendererContractOnlyImports }] },
  }, filename)
}

// The other half of the same rule: a contract module the renderer imports carries a hand-written
// .d.ts, because the renderer is the only consumer TypeScript reads. The per-file parity test walks
// .d.ts files, so a module with NO sidecar is invisible to it — which is how contract/events.js
// reached the renderer's door with no EventName to import.
test('every contract module the renderer imports has a .d.ts twin', (t) => {
  const contractDir = path.join(here, '..', '..', 'src', 'shared', 'contract')
  const imported = new Set()
  for (const file of walk(rendererDir)) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/shared\/contract\/([a-z0-9-]+)\.js/g)) imported.add(m[1])
  }

  t.ok(imported.size >= 10, `the renderer imports ${imported.size} contract modules`)
  for (const name of [...imported].sort()) {
    t.ok(existsSync(path.join(contractDir, name + '.d.ts')), `contract/${name}.js has a .d.ts twin`)
  }
})

// The renderer may import the contract package and nothing else under src/shared/. Every renderer
// twin of a data-layer rule began as an import that was not allowed and a copy that was; the
// re-export shims that used to stand in for this rule are gone, and this is what replaces them.
test('src/renderer imports src/shared/contract/** and nothing else under src/shared/', (t) => {
  const linter = new Linter()

  t.ok(verify(linter, "import { AppError } from '../shared/core/errors.js'\n", 'control.ts').length > 0, 'a core import is caught')
  t.ok(verify(linter, "import { x } from '../../shared/folders/path-keys.js'\n", 'a/control2.tsx').length > 0, 'a nested domain import is caught')
  t.ok(verify(linter, "export { x } from '../shared/transfer/decoration-key.js'\n", 'control3.ts').length > 0, 'a re-export is an import too')
  t.alike(verify(linter, "import { Scope } from '../shared/contract/scope.js'\n", 'ok.ts'), [], 'the contract is the supported door')
  t.alike(verify(linter, "import type { MountFault } from '../../../shared/contract/mount-fault.js'\n", 'a/b/ok2.tsx'), [], 'at any depth')
  t.alike(verify(linter, "import { useShared } from './hooks/useShared.js'\n", 'ok3.tsx'), [], 'a renderer path that merely contains the word stays legal')

  const files = walk(rendererDir)
  t.ok(files.length > 100, 'src/renderer was actually walked')
  for (const file of files) {
    t.alike(verify(linter, readFileSync(file, 'utf8'), file).map((m) => `${m.line}: ${m.message}`), [], path.relative(process.cwd(), file))
  }
})
