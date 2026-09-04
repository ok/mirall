import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { Linter } from 'eslint'
import tseslint from 'typescript-eslint'
import noUnguardedAsyncEffect from '../../eslint-rules/no-unguarded-async-effect.js'
import { unmountOnlyAsyncEffects, outOfOrderAsyncEffects } from '../../eslint.config.mjs'
import { MAIN_QUERIES, MAIN_QUERY_NAMES } from '../../src/renderer/store/main-queries.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')

function walk (dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    // `.js` matters: src/renderer/store/* is the sanctioned implementation of this property and the
    // predecessor guard never scanned it, so nothing checked that the answer stayed the answer.
    else if (/\.(js|ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

// Driven with NO allowances — the `allow` option in eslint.config.mjs only keeps CI and the editor
// quiet about the files below, and cannot hide anything from this scan.
function verify (linter, source, filename) {
  return linter.verify(source, {
    files: ['**/*.{js,ts,tsx}'],
    languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { local: { rules: { 'no-unguarded-async-effect': noUnguardedAsyncEffect } } },
    rules: { 'local/no-unguarded-async-effect': 'error' },
  }, filename).filter((m) => m.ruleId === 'local/no-unguarded-async-effect')
}

const wrap = (body, hooks = 'const [x, setX] = useState(null)') => `
function Component ({ dep }) {
  ${hooks}
  ${body}
  return x
}
`

// REGRESSION (FIX-STALE-2: the predecessor guard matched the TEXT `let cancelled = false` and
// counted at most four files. Six more hand-rolled guards were spelled `alive`, `active`,
// `sawFrame` or `runRef` and were invisible to it; six effects had no guard at all and were
// invisible to it by construction, because absence has no spelling. It reported the property
// covered while three of those six could paint a superseded response over current state.
//
// These fixtures are the grammar itself: what must be caught, and — the half a widened regex could
// never express — what must stay legal.)
test('REGRESSION (FIX-STALE-2): an async effect that writes state names its supersession strategy', (t) => {
  const linter = new Linter()
  const caught = (body, hooks) => verify(linter, wrap(body, hooks), 'fixture.tsx').length > 0
  const legal = (body, hooks) => verify(linter, wrap(body, hooks), 'fixture.tsx').map((m) => m.message)

  t.ok(caught('useEffect(() => { read().then(setX) }, [dep])'), 'a bare .then(setX) is caught')
  t.ok(caught('useEffect(() => { async function run () { const v = await read(); setX(v) } void run() }, [dep])'),
    'an await followed by a setter is caught')
  t.ok(caught(
    'useEffect(() => { void refresh() }, [refresh])',
    'const [x, setX] = useState(null)\n  const refresh = useCallback(async () => { const v = await read(); setX(v) }, [dep])',
  ), 'async work inside a useCallback the effect calls is caught — the shape all three live defects took')

  t.alike(legal('useEffect(() => { let cancelled = false; read().then((v) => { if (cancelled) return; setX(v) }); return () => { cancelled = true } }, [dep])'),
    [], 'a cleanup flag spelled `cancelled` is legal')
  t.alike(legal('useEffect(() => { let alive = true; read().then((v) => { if (!alive) return; setX(v) }); return () => { alive = false } }, [dep])'),
    [], 'the same flag spelled `alive` is equally legal — the guard is recognised by structure')
  t.alike(legal('useEffect(() => { let active = true; read().then((v) => { if (!active) return; setX(v) }); return () => { active = false } }, [dep])'),
    [], 'and spelled `active`')
  t.alike(legal(
    'useEffect(() => { const run = ++runRef.current; read().then((v) => { if (run !== runRef.current) return; setX(v) }) }, [dep])',
    'const [x, setX] = useState(null)\n  const runRef = useRef(0)',
  ), [], 'a generation ref is legal')
  t.alike(legal('useEffect(() => { const c = new AbortController(); read(c.signal).then(setX); return () => c.abort() }, [dep])'),
    [], 'an abort signal is legal')
  t.alike(legal('useEffect(() => { fetchQuery("x").then(setX) }, [dep])'),
    [], 'reading through the store, which owns seq and abort, is legal')
  t.alike(legal('useEffect(() => { async function run () { setX(true); await read() } void run() }, [dep])'),
    [], 'a setter BEFORE the await is not a race')
  t.alike(legal('useEffect(() => { async function run () { await read(); subscribe("event:x", (m) => setX(m)) } void run() }, [dep])'),
    [], 'an event handler registered after an await is a fresh context, not a continuation')
  t.alike(legal(
    'useEffect(() => { read().then((el) => setWrapperRef(el)) }, [dep])',
    'const [x, setX] = useState(null)\n  function setWrapperRef (el) { holder = el }',
  ), [], 'a plain function whose name merely starts with `set` is not a setter — the binding decides, not the spelling')
})

// A ratchet, not a snapshot: the table lives in eslint.config.mjs so the rule and this scan cannot
// disagree about what is exempt, and every entry states its reason there.
test('the renderer has no unguarded async effect outside the exemption table', (t) => {
  const linter = new Linter()
  const found = {}
  for (const f of walk(path.join(root, 'src', 'renderer'))) {
    const messages = verify(linter, readFileSync(f, 'utf8'), f)
    if (messages.length) found[path.relative(root, f).split(path.sep).join('/')] = messages.length
  }

  const table = { ...outOfOrderAsyncEffects, ...unmountOnlyAsyncEffects }
  const unexpected = Object.keys(found).filter((f) => !(f in table)).sort()
  t.alike(unexpected, [], 'a new unguarded async effect was introduced — read through useQuery/useMainQuery, or carry a generation ref')

  for (const [file, entry] of Object.entries(table)) {
    t.ok((found[file] ?? 0) <= entry.effects, `${file} has at most ${entry.effects} exempt effect(s)`)
  }

  const stale = Object.keys(table).filter((f) => !(f in found)).sort()
  t.alike(stale, [], 'an exemption outlived the effect it excused — delete the row')
})

// OUT_OF_ORDER is the whole point of splitting the table. An effect that re-fires can have two
// reads in flight, and the older one winning is wrong data on screen; there is no reason that makes
// that acceptable, so the list has no legal contents.
test('no out-of-order async effect is exempted', (t) => {
  t.alike(Object.keys(outOfOrderAsyncEffects), [], 'an out-of-order race was allowlisted instead of fixed')
})

// An exemption is only honest if it SAYS why. A file listed without a reason is indistinguishable
// from one nobody got round to migrating.
test('every exemption states its reason', (t) => {
  for (const [file, entry] of Object.entries({ ...outOfOrderAsyncEffects, ...unmountOnlyAsyncEffects })) {
    t.is(typeof entry.effects, 'number', `${file} caps how many effects it exempts`)
    t.ok(typeof entry.why === 'string' && entry.why.length > 40, `${file} explains why it is exempt`)
  }
})

// Symmetric to contract-requests.test.js's "every renderer request literal names a real request",
// for the main-process side of the renderer's read surface.
test('every main-query literal in the renderer names a declared fact', (t) => {
  const unknown = new Set()
  for (const f of walk(path.join(root, 'src', 'renderer'))) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/'(main:[a-z-]+)'/g)) {
      if (!MAIN_QUERIES[m[1]]) unknown.add(`${m[1]} (${path.relative(root, f)})`)
    }
  }
  t.alike([...unknown], [], 'the renderer reads a main fact that is not declared')
})

test('every declared main fact is well formed', (t) => {
  for (const name of MAIN_QUERY_NAMES) {
    const spec = MAIN_QUERIES[name]
    t.is(typeof spec.read, 'function', `${name} has a read`)
    t.is(typeof spec.write, 'function', `${name} has a write`)
    t.ok(spec.push === null || typeof spec.push === 'string', `${name} declares its push channel`)
  }
})
