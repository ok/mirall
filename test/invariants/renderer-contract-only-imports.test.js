import test from 'brittle'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { Linter } from 'eslint'
import tsParser from '@typescript-eslint/parser'
import { rendererContractOnlyImports } from '../../eslint-rules/invariants.mjs'

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

function walkAll(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'node_modules') walkAll(p, out) }
    else out.push(p)
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

// A .d.ts beside a .js is a declaration TypeScript reads INSTEAD of the implementation and never
// compares with it, so the pair can disagree and typecheck clean. Every module the renderer
// imports carries its types in the source under checkJs; the one ambient declaration file,
// platform/global.d.ts, declares window.bridge and has no .js.
test('no .js module under src/ carries a .d.ts sidecar', (t) => {
  const srcDir = path.join(here, '..', '..', 'src')
  const sidecars = walkAll(srcDir)
    .filter((f) => f.endsWith('.d.ts') && existsSync(f.replace(/\.d\.ts$/, '.js')))
    .map((f) => path.relative(srcDir, f))
  t.alike(sidecars, [], 'a sidecar came back')
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
