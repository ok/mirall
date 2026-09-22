// Listed files have these checks off in eslint, so a new site in one shows here, not in the editor.
import test from 'brittle'
import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { ESLint, Linter } from 'eslint'
import config from '../../eslint.config.mjs'
import {
  rendererStatusRestrictions,
  byteFormatterSingleOwnerRestrictions,
  swallowedRejectionRestrictions,
  swallowedRejectionExemptions,
  promiseLintAllowlist,
} from '../../eslint-rules/invariants.mjs'
import { siteKeys } from '../helpers/lint-site-key.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const TYPED_RULES = ['@typescript-eslint/no-floating-promises', '@typescript-eslint/no-misused-promises']
const GUARDED_RULES = [...TYPED_RULES, 'no-restricted-syntax', 'no-empty']
const FIXTURE = 'test/invariants/promise-lint-fixture.ts'

const rendererBlock = config.find((block) => (block.files ?? []).includes('src/renderer/**/*.{ts,tsx,js}'))
const typedRules = Object.fromEntries(TYPED_RULES.map((rule) => [rule, rendererBlock.rules[rule]]))
const typedPlugin = { '@typescript-eslint': rendererBlock.plugins['@typescript-eslint'] }

function typedLinter(rules, languageOptions = rendererBlock.languageOptions, files = rendererBlock.files) {
  return new ESLint({
    cwd: root,
    overrideConfigFile: true,
    allowInlineConfig: false,
    overrideConfig: [{ files, languageOptions, plugins: typedPlugin, rules }],
  })
}

// The renderer block's parser, with one virtual file admitted to the project so fixtures type-check.
const fixtureLanguageOptions = {
  ...rendererBlock.languageOptions,
  parserOptions: { ...rendererBlock.languageOptions.parserOptions, projectService: { allowDefaultProject: [FIXTURE] } },
}

async function typedFixtureHits(rules, source) {
  const [result] = await typedLinter(rules, fixtureLanguageOptions, ['**/*.ts']).lintText(source, { filePath: FIXTURE })
  assertParsed(result)
  return result.messages.map((m) => m.ruleId)
}

function assertParsed(result) {
  const fatal = result.messages.filter((m) => m.fatal)
  if (fatal.length) throw new Error(fatal[0].message)
}

const selectorLinter = new Linter()
function verifySelectors(source, filename) {
  return selectorLinter.verify(source, {
    files: ['**/*.{js,ts,tsx}'],
    languageOptions: { parser: rendererBlock.languageOptions.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: { 'no-restricted-syntax': ['error', ...swallowedRejectionRestrictions] },
  }, { filename, allowInlineConfig: false }).filter((m) => m.ruleId === 'no-restricted-syntax')
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(js|ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

function assertSites(t, file, found, table, label) {
  t.alike([...found].sort(), [...table[file].sites].sort(), `${file} has exactly its listed ${label} sites — a new, swapped or fixed site changes this list`)
}

test('the renderer lints promises with void flagged', (t) => {
  t.alike(typedRules['@typescript-eslint/no-floating-promises'], ['error', { ignoreVoid: false }], 'no-floating-promises treats `void` as unhandled')
  t.is(typedRules['@typescript-eslint/no-misused-promises'], 'error', 'no-misused-promises is on')
})

test('a listed file keeps no-misused-promises for conditionals and spreads', async (t) => {
  const eslint = new ESLint({ cwd: root })
  for (const file of Object.keys(promiseLintAllowlist)) {
    const { rules } = await eslint.calculateConfigForFile(file)
    t.is(rules['@typescript-eslint/no-floating-promises'][0], 0, `${file}: floating is the ratchet's`)
    t.alike(rules['@typescript-eslint/no-misused-promises'], [2, { checksVoidReturn: false }], `${file}: only void-return is the ratchet's`)
  }
})

// A later no-restricted-syntax replaces an earlier one, so the composed config is the only honest
// place to check that every renderer table still applies.
test('every renderer table applies to the files it governs', async (t) => {
  const eslint = new ESLint({ cwd: root })
  const selectors = async (file) => new Set((await eslint.calculateConfigForFile(file)).rules['no-restricted-syntax'].slice(1).map((r) => r.selector))
  const covers = (set, table) => table.every((r) => set.has(r.selector))

  const screen = await selectors('src/renderer/screens/FolderScreen.tsx')
  t.ok(covers(screen, rendererStatusRestrictions), 'a screen carries the status invariant')
  t.ok(covers(screen, byteFormatterSingleOwnerRestrictions), 'a screen carries the byte ladder')
  t.ok(covers(screen, swallowedRejectionRestrictions), 'a screen carries the swallowed-rejection grammar')

  const store = await selectors('src/renderer/store/main-store.js')
  t.ok(covers(store, swallowedRejectionRestrictions), 'the grammar reaches past screens, controls and hooks')

  const exempt = await selectors(Object.keys(swallowedRejectionExemptions)[0])
  t.ok(covers(exempt, rendererStatusRestrictions) && covers(exempt, byteFormatterSingleOwnerRestrictions), 'an exempt file keeps the other tables')

  const bytes = await selectors('src/renderer/format/bytes.js')
  t.ok(covers(bytes, rendererStatusRestrictions) && covers(bytes, swallowedRejectionRestrictions), 'the byte ladder owner keeps the other tables')
})

test('the swallowed-rejection grammar: what is caught and what stays legal', (t) => {
  const hits = (src) => verifySelectors(src, 'fixture.ts').length

  t.is(hits('try { go() } catch { /* fine */ }'), 1, 'a catch holding only a comment is caught')
  t.is(hits('try { go() } catch (err) {}'), 1, 'an empty catch with a binding is caught')
  t.is(hits('function f () { try { go() } catch { return } }'), 1, 'a catch holding only a bare return is caught')
  t.is(hits('go().catch(() => {})'), 1, 'an empty arrow handed to .catch is caught')
  t.is(hits('go().catch(function () {})'), 1, 'an empty function handed to .catch is caught')
  t.is(hits('go().catch(function () { return })'), 1, 'a bare return handed to .catch is caught')
  t.is(hits('go().catch(() => undefined)'), 1, '`() => undefined` is caught')
  t.is(hits('go().catch(() => void 0)'), 1, '`() => void 0` is caught')
  t.is(hits('go().catch(noop)'), 1, 'a function named as a no-op is caught')
  t.is(hits('go().then(ok, () => {})'), 1, 'a no-op second argument to .then is caught')
  t.is(hits('go().then(ok, noop)'), 1, 'a named no-op second argument to .then is caught')

  t.is(hits('try { go() } catch (err) { report(err) }'), 0, 'a catch that reports is legal')
  t.is(hits('function f () { try { return go() } catch { return null } }'), 0, 'a catch returning a fallback is legal')
  t.is(hits('try { go() } finally { done() }'), 0, 'try/finally has no catch to swallow')
  t.is(hits('go().catch(report)'), 0, 'a named handler is legal')
  t.is(hits('go().catch(() => void report())'), 0, '`void` over a real call is a handler')
  t.is(hits('go().catch(() => null)'), 0, 'a fallback value is a decision, not a swallow')
  t.is(hits('go().then(() => {})'), 0, 'an empty success handler swallows nothing')
})

test('the typed grammar, and what a listed file still enforces', async (t) => {
  const listed = { '@typescript-eslint/no-floating-promises': 'off', '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }] }
  const decl = 'const p = (): Promise<void> => Promise.resolve()\nconst run = (f: () => void): void => f()\n'
  const src = (body) => `${decl}${body}\nexport {}\n`

  t.alike(await typedFixtureHits(typedRules, src('void p()')), ['@typescript-eslint/no-floating-promises'], '`void` is flagged')
  t.alike(await typedFixtureHits(typedRules, src('run(async () => { await p() })')), ['@typescript-eslint/no-misused-promises'], 'a promise handed to a void callback is flagged')
  t.alike(await typedFixtureHits(typedRules, src('p().catch((err) => console.error(err))')), [], 'a handled promise is legal')

  t.alike(await typedFixtureHits(listed, src('void p()')), [], 'a listed file leaves floating promises to the ratchet')
  t.alike(await typedFixtureHits(listed, src('if (p()) run(() => {})')), ['@typescript-eslint/no-misused-promises'], 'but still flags a promise used as a condition')
  t.alike(await typedFixtureHits(listed, src('const o = { ...p() }\nrun(() => o)')), ['@typescript-eslint/no-misused-promises'], 'and a promise spread')
})

test('exempt files swallow exactly their listed rejections', (t) => {
  for (const file of Object.keys(swallowedRejectionExemptions)) {
    const source = readFileSync(path.join(root, file), 'utf8')
    assertSites(t, file, siteKeys(source, file, verifySelectors(source, file)), swallowedRejectionExemptions, 'swallowed-rejection')
  }
})

test('allowlisted files hold exactly their listed unhandled promises', { timeout: 120000 }, async (t) => {
  const results = await typedLinter(typedRules).lintFiles(Object.keys(promiseLintAllowlist))
  for (const r of results) {
    assertParsed(r)
    const file = path.relative(root, r.filePath).split(path.sep).join('/')
    const messages = r.messages.filter((m) => TYPED_RULES.includes(m.ruleId))
    assertSites(t, file, siteKeys(readFileSync(r.filePath, 'utf8'), file, messages), promiseLintAllowlist, 'unhandled-promise')
  }
})

// An inline disable would hide a site from eslint and — with inline config honoured — from the
// ratchet as well.
test('no inline disable of the promise or swallow rules in the renderer', (t) => {
  const offenders = []
  for (const f of walk(path.join(root, 'src', 'renderer'))) {
    for (const m of readFileSync(f, 'utf8').matchAll(/eslint-disable(?:-next-line|-line)?([^\n]*)/g)) {
      const named = m[1].replace(/\*\/.*$/, '').split(/\s--\s/)[0].split(/[\s,]+/).filter(Boolean)
      if (named.length === 0 || named.some((rule) => GUARDED_RULES.includes(rule))) offenders.push(`${path.relative(root, f)}: ${m[0].trim()}`)
    }
  }
  t.alike(offenders, [], 'report the failure or list the site with its reason instead')
})

test('every exemption and allowlist row names a real file and states its reason', (t) => {
  for (const table of [swallowedRejectionExemptions, promiseLintAllowlist]) {
    for (const [file, entry] of Object.entries(table)) {
      t.ok(existsSync(path.join(root, file)), `${file} exists`)
      t.ok(Array.isArray(entry.sites) && entry.sites.length > 0, `${file} lists its sites`)
      t.ok(typeof entry.why === 'string' && entry.why.length > 30, `${file} explains why`)
    }
  }
})
