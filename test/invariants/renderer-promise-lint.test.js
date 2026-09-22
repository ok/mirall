import test from 'brittle'
import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { ESLint, Linter } from 'eslint'
import tseslint from 'typescript-eslint'
import config from '../../eslint.config.mjs'
import {
  swallowedRejectionRestrictions,
  swallowedRejectionExemptions,
  promiseLintAllowlist,
} from '../../eslint-rules/invariants.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const rel = (p) => path.relative(root, p).split(path.sep).join('/')
const TYPED_RULES = ['@typescript-eslint/no-floating-promises', '@typescript-eslint/no-misused-promises']

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(js|ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

const rendererBlock = config.find((block) => (block.files ?? []).includes('src/renderer/**/*.{ts,tsx,js}'))
const typedRules = Object.fromEntries(TYPED_RULES.map((rule) => [rule, rendererBlock.rules[rule]]))

// The typed rules exactly as the renderer block configures them, with no allowlist.
function typedLinter() {
  return new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: [{
      files: ['src/renderer/**/*.{ts,tsx,js}'],
      languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true }, projectService: true, tsconfigRootDir: root } },
      plugins: { '@typescript-eslint': tseslint.plugin },
      rules: typedRules,
    }],
  })
}

function verifySelectors(linter, source, filename) {
  return linter.verify(source, {
    files: ['**/*.{js,ts,tsx}'],
    languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: { 'no-restricted-syntax': ['error', ...swallowedRejectionRestrictions] },
  }, filename).filter((m) => m.ruleId === 'no-restricted-syntax')
}

function assertRatchet(t, found, table, countKey, label) {
  const unexpected = Object.keys(found).filter((f) => !(f in table)).sort()
  t.alike(unexpected, [], `a new ${label} was introduced — report the failure, or add a row with its reason`)
  for (const [file, entry] of Object.entries(table)) {
    const n = found[file] ?? 0
    if (n === 0) continue
    t.is(n, entry[countKey], `${file} has exactly ${entry[countKey]} allowed ${label}(s) — lower the count when one is fixed`)
  }
  const stale = Object.keys(table).filter((f) => !(f in found)).sort()
  t.alike(stale, [], `a row outlived the ${label} it excused — delete it`)
}

test('the renderer lints promises with void flagged', (t) => {
  t.alike(typedRules['@typescript-eslint/no-floating-promises'], ['error', { ignoreVoid: false }], 'no-floating-promises treats `void` as unhandled')
  t.is(typedRules['@typescript-eslint/no-misused-promises'], 'error', 'no-misused-promises is on')
})

test('the swallowed-rejection grammar: what is caught and what stays legal', (t) => {
  const linter = new Linter()
  const hits = (src) => verifySelectors(linter, src, 'fixture.ts').length

  t.is(hits('try { go() } catch { /* fine */ }'), 1, 'a catch holding only a comment is caught')
  t.is(hits('try { go() } catch (err) {}'), 1, 'an empty catch with a binding is caught')
  t.is(hits('go().catch(() => {})'), 1, 'an empty arrow handed to .catch is caught')
  t.is(hits('go().catch(function () {})'), 1, 'an empty function handed to .catch is caught')

  t.is(hits('try { go() } catch (err) { report(err) }'), 0, 'a catch that reports is legal')
  t.is(hits('try { go() } finally { done() }'), 0, 'try/finally has no catch to swallow')
  t.is(hits('go().catch(report)'), 0, 'a named handler is legal')
  t.is(hits('go().catch(() => null)'), 0, 'a fallback value is a decision, not a swallow')
})

test('screens, controls and hooks swallow no rejection outside the exemption table', (t) => {
  const linter = new Linter()
  const found = {}
  for (const dir of ['screens', 'components', 'hooks']) {
    for (const f of walk(path.join(root, 'src', 'renderer', dir))) {
      const n = verifySelectors(linter, readFileSync(f, 'utf8'), f).length
      if (n) found[rel(f)] = n
    }
  }
  assertRatchet(t, found, swallowedRejectionExemptions, 'sites', 'swallowed rejection')
})

test('the renderer has no unhandled promise outside the allowlist', { timeout: 120000 }, async (t) => {
  const results = await typedLinter().lintFiles(['src/renderer'])
  const found = {}
  const unparsed = []
  for (const r of results) {
    const n = r.messages.filter((m) => TYPED_RULES.includes(m.ruleId)).length
    if (n) found[rel(r.filePath)] = n
    if (r.messages.some((m) => m.fatal)) unparsed.push(rel(r.filePath))
  }
  t.alike(unparsed, [], 'every renderer file parses under the project service')
  assertRatchet(t, found, promiseLintAllowlist, 'hits', 'unhandled promise')
})

test('every exemption and allowlist row names a real file and states its reason', (t) => {
  for (const [file, entry] of Object.entries(swallowedRejectionExemptions)) {
    t.ok(existsSync(path.join(root, file)), `${file} exists`)
    t.is(typeof entry.sites, 'number', `${file} caps its sites`)
    t.ok(typeof entry.why === 'string' && entry.why.length > 30, `${file} explains why it is exempt`)
  }
  for (const [file, entry] of Object.entries(promiseLintAllowlist)) {
    t.ok(existsSync(path.join(root, file)), `${file} exists`)
    t.is(typeof entry.hits, 'number', `${file} caps its hits`)
    t.ok(typeof entry.why === 'string' && entry.why.length > 30, `${file} explains why it is allowlisted`)
  }
})
