import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { Linter } from 'eslint'
import config from '../../eslint.config.mjs'
import { ENGINE_DIR, engineClosedGraph, engineDynamicImport } from '../../eslint-rules/invariants.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const verify = (linter, code, patterns) => linter.verify(code, {
  files: ['**/*.js'],
  languageOptions: { ecmaVersion: 2025, sourceType: 'module' },
  rules: { 'no-restricted-imports': ['error', { patterns }], 'no-restricted-syntax': ['error', ...engineDynamicImport] },
}, 'x.js')

test('the engine rule bites on every way out of engine/, and only on those', (t) => {
  const linter = new Linter()
  const { top, nested } = engineClosedGraph
  t.ok(verify(linter, "import x from '../overlay-instance.js'\n", top).length > 0, 'engine/*.js climbing out is caught')
  t.ok(verify(linter, "import { getStore } from '../../../core/store.js'\n", nested).length > 0, 'engine/<dir>/*.js climbing out is caught')
  t.ok(verify(linter, "export { x } from '../../serve-registration.js'\n", nested).length > 0, 'a re-export is an import')
  t.ok(verify(linter, "import x from '../../../../src/shared/core/logger.js'\n", nested).length > 0, 'an src/ path at any depth')
  t.ok(verify(linter, "const m = await import('./x.js')\n", nested).length > 0, 'a dynamic import is refused outright')
  t.alike(verify(linter, "import * as m from '../wire/messages.js'\n", nested), [], 'a sibling engine dir is legal')
  t.alike(verify(linter, "import { hashChunk } from './chunker.js'\n", top), [], 'a same-dir import is legal')
  t.alike(verify(linter, "import c from 'compact-encoding'\n", nested), [], 'packages are legal')
})

test('eslint.config.mjs applies exactly this grammar to the engine', (t) => {
  const uses = (patterns) => config.some((b) => b.rules?.['no-restricted-imports']?.[1]?.patterns === patterns)
  t.ok(uses(engineClosedGraph.top) && uses(engineClosedGraph.nested), 'both depth blocks are wired from the exported arrays')
  t.absent(config.some((b) => (b.ignores ?? []).some((g) => g.startsWith(ENGINE_DIR))), 'no ignore covers the engine')
})

test('every real engine file passes, and none sits deeper than engine/<dir>/<file>', (t) => {
  const linter = new Linter()
  const walk = (dir, depth, out = []) => {
    for (const n of readdirSync(dir)) {
      const p = path.join(dir, n)
      if (statSync(p).isDirectory()) walk(p, depth + 1, out)
      else if (n.endsWith('.js')) out.push([p, depth])
    }
    return out
  }
  const files = walk(path.join(root, ENGINE_DIR), 0)
  t.ok(files.length >= 20, 'the engine was walked')
  for (const [file, depth] of files) {
    t.ok(depth <= 1, `${path.relative(root, file)} is at most one directory deep`)
    const patterns = depth === 0 ? engineClosedGraph.top : engineClosedGraph.nested
    t.alike(verify(linter, readFileSync(file, 'utf8'), patterns).map((m) => `${m.line}: ${m.message}`), [], path.relative(root, file))
  }
})
