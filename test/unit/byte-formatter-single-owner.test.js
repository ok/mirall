import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { Linter } from 'eslint'
import tseslint from 'typescript-eslint'
import { byteFormatterSingleOwnerRestrictions } from '../../eslint.config.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const rendererDir = path.join(here, '..', '..', 'src', 'renderer')
const OWNER = path.join(rendererDir, 'formatSize.js')

function walk (dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(js|ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

function verify (linter, source, filename) {
  return linter.verify(source, {
    files: ['**/*.{js,ts,tsx}'],
    languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: { 'no-restricted-syntax': ['error', ...byteFormatterSingleOwnerRestrictions] },
  }, filename)
    // Renderer files carry inline eslint-disable comments for jsx-a11y rules this minimal Linter
    // does not register, and eslint reports each one as a "rule not found" message. Only this
    // rule's own verdict is the subject here.
    .filter((m) => m.ruleId === 'no-restricted-syntax')
}

// REGRESSION (FIX-BYTES-2: auditRow.js carried a second byte ladder — decimal labels over a binary
// divisor — so the Activity Log read ~7.4% below every other screen for the same file, and
// test/unit/audit-row.test.js pinned the wrong numbers. Deleting that ladder fixes today's
// discrepancy; this rule is what stops the NEXT one, in any spelling: it matches the SHAPE of a
// unit ladder, an array literal carrying a byte-unit element, not a variable called BYTES_UNITS.)
test('REGRESSION (FIX-BYTES-2): src/renderer/formatSize.js is the only module that declares a byte ladder', (t) => {
  const linter = new Linter()

  t.ok(verify(linter, "const U = ['B', 'KB', 'MB', 'GB', 'TB']\n", 'control.js').length > 0, 'a decimal ladder is caught')
  t.ok(verify(linter, 'const U = ["B", "KB", "MB"]\n', 'control2.js').length > 0, 'quote style does not matter')
  t.ok(verify(linter, "const U = ['bytes', 'KiB', 'MiB', 'GiB']\n", 'control3.js').length > 0, 'a binary ladder is caught too')
  t.ok(verify(linter, "const anything = ['GB']\n", 'control4.js').length > 0, 'renaming the array changes nothing')
  t.alike(verify(linter, "const s = formatSize(bytes, locale)\n", 'ok.js'), [], 'calling the owner is the supported door')
  t.alike(verify(linter, 'const PRESET_KBPS = [0, 1024, 5120, 25600]\n', 'ok2.js'), [], 'a numeric rate ladder stays legal')
  t.alike(verify(linter, "const speed = size + ' KB/s'\n", 'ok3.js'), [], 'a bandwidth label stays legal')
  t.alike(verify(linter, "const unit = 'KB'\n", 'ok4.js'), [], 'a lone unit string outside an array stays legal')

  const files = walk(rendererDir).filter((f) => f !== OWNER)
  t.ok(files.length > 0, 'src/renderer was actually walked')
  for (const file of files) {
    t.alike(verify(linter, readFileSync(file, 'utf8'), file).map((m) => `${m.line}: ${m.message}`), [], path.relative(process.cwd(), file))
  }
  t.ok(/const UNITS = \['B', 'KB'/.test(readFileSync(OWNER, 'utf8')), 'and formatSize.js is where the ladder actually lives')
})
