import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')
const SCAN = ['src/renderer', 'src/main', 'src/shared/contract']
const PLURAL = /_(one|other|zero|two|few|many)$/

// Keys the scan cannot see but which are live, each with the site that will consume it. A key
// that merely stopped being used does not belong here — delete it from all five locales instead.
const ALLOW = []

function flatten(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? prefix + '.' + k : k
    if (v && typeof v === 'object') flatten(v, key, out)
    else out.push(key)
  }
  return out
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'locales' && name !== 'vendor') walk(p, out) }
    else if (/\.(js|ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const PREFIX_SHAPE = /^[a-zA-Z][\w-]*(\.[\w-]+)*\.$/

// Every quoted literal, plus a pattern per dynamic key: a template whose static head is a dotted
// prefix (`leaveSpace.phases.${phase}`, `networkSettings.${dir}CustomLabel`) and a literal ending
// in a dot ('activityLog.kindLabel.' + kind). A template with no such head (`${a}.${b}`) says
// nothing about which keys exist and is ignored rather than allowed to match everything.
function references() {
  const corpus = SCAN.flatMap((d) => walk(path.join(root, d))).map((f) => readFileSync(f, 'utf8')).join('\n')
  const literals = new Set()
  const patterns = []
  for (const m of corpus.matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"/g)) {
    const s = m[1] ?? m[2]
    literals.add(s)
    if (PREFIX_SHAPE.test(s)) patterns.push(new RegExp('^' + esc(s) + '.+$'))
  }
  for (const m of corpus.matchAll(/`([^`]*)`/g)) {
    if (!m[1].includes('${')) { literals.add(m[1]); continue }
    const segs = m[1].split(/\$\{[^}]*\}/)
    if (!PREFIX_SHAPE.test(segs[0])) continue
    patterns.push(new RegExp('^' + segs.map(esc).join('.+') + '$'))
  }
  return { literals, patterns }
}

test('every en locale key is referenced by the renderer, main or the contract', (t) => {
  const { literals, patterns } = references()
  t.ok(literals.size > 1000, 'the source tree was actually scanned')

  const referenced = (key) => {
    const base = key.replace(PLURAL, '')
    if (literals.has(key) || literals.has(base)) return true
    if (ALLOW.some((re) => re.test(key))) return true
    return patterns.some((re) => re.test(key) || re.test(base))
  }

  for (const ns of ['common', 'errors']) {
    const en = JSON.parse(readFileSync(path.join(root, 'src', 'renderer', 'locales', 'en', ns + '.json'), 'utf8'))
    const keys = flatten(en)
    t.ok(keys.length > 40, `${ns}.json was actually read`)
    t.alike(keys.filter((k) => !referenced(k)), [], `${ns}.json: every key is named somewhere (delete it from all five locales, or add its dynamic site to ALLOW)`)
  }
})

// The scan must be able to fail, or a corpus mistake would report every key covered.
test('the scan sees a literal, a plural base and a dotted-prefix template — and not a bare one', (t) => {
  const { literals, patterns } = references()
  t.ok(literals.has('actions.cancel'), 'a plain t() key is a literal')
  t.ok(patterns.some((re) => re.test('leaveSpace.phases.finalizing')), 'a `prefix.${x}` template covers its family')
  t.absent(patterns.some((re) => re.test('zzz.never.defined')), 'no template matches everything')
})

// i18next picks the plural form from `count`; naming a suffix in the key pins one form for every
// count, so the singular is unreachable and the locale key reads as dead to the scan above.
test('REGRESSION (FIX-PLURAL-SUFFIX): no t() call names a plural suffix in its key', (t) => {
  const files = SCAN.flatMap((d) => walk(path.join(root, d)))
  const offenders = []
  for (const file of files) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/\bt\(\s*['"`]([^'"`]+)['"`]/g)) {
      if (PLURAL.test(m[1])) offenders.push(path.relative(root, file) + ': ' + m[1])
    }
  }
  t.alike(offenders, [], 'pass the base key and { count } instead of a _one/_other key')
})
