import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { KINDS, CATEGORIES, OUTCOME, OUTCOMES } from '../../src/shared/contract/audit-kinds.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(here, '..', '..')
const SRC = path.join(ROOT, 'src')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(js|ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

// Data-layer sources only: the renderer holds a mirror of the vocabulary for search labels, and
// counting it as a call site would let a kind look "wired" while nothing ever records it.
const dataLayerFiles = walk(SRC).filter((f) => f.includes('/shared/') || f.includes('/worker/'))
const dataLayerSource = dataLayerFiles.map((f) => readFileSync(f, 'utf8')).join('\n')

// Every string literal the audit vocabulary could be spelled as. Deliberately NOT anchored to
// `record(` — several kinds are chosen by a ternary inside the call, and one is emitted from the
// rate guard rather than a call site — so the test looks for the literal anywhere in the data
// layer and leaves "is it reachable" to the behavioural suites.
const DOTTED_LITERAL = /'([a-z]+(?:\.[a-z_]+)+)'/g

function literalsIn(source) {
  const out = new Set()
  for (let m; (m = DOTTED_LITERAL.exec(source));) out.add(m[1])
  return out
}

test('every declared kind has a call site in the data layer', (t) => {
  const present = literalsIn(dataLayerSource)
  for (const kind of Object.keys(KINDS)) {
    t.ok(present.has(kind), kind + ' is recorded somewhere — a kind that can never fire still ships search labels and i18n copy')
  }
})

test('every kind the data layer records is declared', (t) => {
  // Anything shaped like a kind and passed to record() must be in the table. buildRecord throws
  // on an unknown kind at runtime, but that only surfaces when the branch executes; this catches
  // a typo or an undeclared kind before it ships.
  const called = new Set()
  const re = /record\(\s*([^)]*?)\)/gs
  for (let m; (m = re.exec(dataLayerSource));) {
    for (const lit of literalsIn(m[1])) called.add(lit)
  }
  t.ok(called.size > 20, 'found the record() call sites')
  for (const kind of called) {
    t.ok(Object.hasOwn(KINDS, kind), kind + ' is declared in audit-kinds.js')
  }
})

// The files that write audit rows. An outcome is what the viewer badges the row on, so the spelling
// has to come from the frozen vocabulary rather than a literal: buildRecord refuses an unknown one,
// but record() is fire-and-forget, so a misspelling costs the row instead of failing the operation.
const auditCallSites = dataLayerFiles.filter((f) => /from '[^']*audit\/audit-log\.js'/.test(readFileSync(f, 'utf8')))

test('every audit call site names its outcome through the frozen vocabulary', (t) => {
  t.ok(auditCallSites.length > 5, `found ${auditCallSites.length} audit call sites`)
  for (const file of auditCallSites) {
    const code = readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '')
    const literals = [...code.matchAll(/outcome:\s*'([^']+)'/g)].map((m) => m[1])
    t.alike(literals, [], path.relative(ROOT, file) + ' spells its outcome as OUTCOME.X, not a literal')
  }
})

// The lookbehind keeps the audit vocabulary's own name: a qualified sibling (FETCH_OUTCOME, the
// overlay's fetch outcomes) is a different vocabulary and must not be judged against this one.
test('every OUTCOME reference in the data layer resolves to a member', (t) => {
  const refs = new Set([...dataLayerSource.matchAll(/(?<![A-Z_])OUTCOME\.([A-Z_]+)/g)].map((m) => m[1]))
  t.ok(refs.size > 0, 'found the OUTCOME references')
  for (const key of refs) {
    t.ok(OUTCOMES.includes(OUTCOME[key]), 'OUTCOME.' + key + ' is a member of the outcome vocabulary')
  }
})

test('every kind is fully described — category, tier, and copy in every locale', (t) => {
  const locales = readdirSync(path.join(SRC, 'renderer', 'locales'))
  const catalogues = locales.map((loc) => [
    loc,
    JSON.parse(readFileSync(path.join(SRC, 'renderer', 'locales', loc, 'common.json'), 'utf8')),
  ])
  for (const [kind, meta] of Object.entries(KINDS)) {
    t.ok(CATEGORIES.includes(meta.category), kind + ' has a known category')
    t.ok(['A', 'B', 'C'].includes(meta.tier), kind + ' has a known tier')
    for (const [loc, cat] of catalogues) {
      t.ok(cat.activityLog?.kind?.[kind], kind + ' has a sentence in ' + loc)
      t.ok(cat.activityLog?.kindLabel?.[kind], kind + ' has a search label in ' + loc)
    }
  }
})

// A sentence is one translatable string interpolated with {{actor}}/{{space}}/{{target}}, and
// splitSentence renders only the placeholders it finds. So a locale that drops one silently loses
// that entity from the row — the whole zero-joins-at-render guarantee, defeated by a translation.
// Pinned against English rather than pairwise, because English is where the copy is authored.
test('every locale interpolates the same fields as English, per kind', (t) => {
  const localeDir = path.join(SRC, 'renderer', 'locales')
  const read = (loc) => JSON.parse(readFileSync(path.join(localeDir, loc, 'common.json'), 'utf8'))
  const fieldsIn = (sentence) => [...String(sentence).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort().join(',')
  const en = read('en').activityLog.kind

  for (const loc of readdirSync(localeDir)) {
    if (loc === 'en') continue
    const kinds = read(loc).activityLog.kind
    for (const kind of Object.keys(KINDS)) {
      t.is(fieldsIn(kinds[kind]), fieldsIn(en[kind]),
        loc + '/' + kind + ' interpolates the same fields as English — a dropped one erases that name from the row')
    }
  }
})

test('no locale carries copy for a kind that no longer exists', (t) => {
  const locales = readdirSync(path.join(SRC, 'renderer', 'locales'))
  for (const loc of locales) {
    const cat = JSON.parse(readFileSync(path.join(SRC, 'renderer', 'locales', loc, 'common.json'), 'utf8'))
    for (const bucket of ['kind', 'kindLabel']) {
      for (const kind of Object.keys(cat.activityLog?.[bucket] || {})) {
        t.ok(Object.hasOwn(KINDS, kind), loc + '/' + bucket + ': ' + kind + ' is a real kind — stale copy means a filter for something that can never appear')
      }
    }
  }
})

// The behavioural counterpart lives in test/flow/audit-coverage.test.js, which drives a real
// two-peer session and asserts the exact set of kinds it produces. This file only pins that the
// vocabulary is internally consistent; that one pins that it is reachable.
test('the behavioural coverage suite exists and enumerates the vocabulary', (t) => {
  const flow = readFileSync(path.join(ROOT, 'test', 'flow', 'audit-coverage.test.js'), 'utf8')
  t.ok(flow.includes('EXPECTED_KINDS'), 'the flow suite declares the set it expects to observe')
  t.ok(flow.includes('UNTRIGGERABLE'), 'and accounts explicitly for the kinds it cannot drive')
})
