import test from 'brittle'
import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { Linter } from 'eslint'
import tsParser from '@typescript-eslint/parser'
import { rendererStatusRestrictions } from '../../eslint.config.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const hooksDir = path.join(here, '..', '..', 'src', 'renderer', 'hooks')

function verify (linter, source, filename) {
  return linter.verify(source, {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: { 'no-restricted-syntax': ['error', ...rendererStatusRestrictions] },
  }, filename)
}

// The EDA invariant ("renderer event handlers never construct row status"), pinned at the test
// layer next to the CI lint rule so a lint-config regression can't silently drop it. Runs the
// SAME exported selectors through eslint's own parser — no bespoke grammar to drift.
test('renderer hooks never construct row status inside event handlers', (t) => {
  const linter = new Linter()
  // Positive controls: the harness must be able to fail, or a config/filename mismatch would
  // report the invariant pinned while verifying nothing.
  const control = verify(linter, "subscribe('e', () => { setRows((r) => ({ ...r, status: 'done' })) })\n", 'control.ts')
  t.ok(control.length > 0, 'shorthand construction in a subscribe callback is caught')
  const quoted = verify(linter, "subscribe('e', () => ({ 'status': 1 }))\n", 'control-quoted.ts')
  t.ok(quoted.length > 0, 'quoted-key construction is caught')
  const read = verify(linter, "subscribe('e', (msg) => { const { status } = msg; void status })\n", 'control-read.ts')
  t.alike(read, [], 'a destructured READ of a payload status field stays legal')

  for (const file of readdirSync(hooksDir).filter((f) => /\.tsx?$/.test(f))) {
    const src = readFileSync(path.join(hooksDir, file), 'utf8')
    const messages = verify(linter, src, `hooks/${file}`)
    t.alike(messages.map((m) => `${m.line}: ${m.message}`), [], `${file}: no status construction in event handlers`)
  }
})
