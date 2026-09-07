import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { REQUESTS, REQUEST_NAMES, UNREFERENCED_REQUESTS, ARG } from '../../src/shared/contract/requests.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')

function walk (dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(js|ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

function handlerNames () {
  const files = [path.join(root, 'src', 'worker', 'main.js'), ...walk(path.join(root, 'src', 'worker', 'ipc'))]
  const names = []
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(/ipc\.handle\('([A-Za-z:.-]+)'/g)) names.push(m[1])
  }
  return names
}

// REGRESSION (FIX-CONTRACT-REQUESTS: 72 renderer request literals faced 85 handlers with no guard in
// either direction — a renamed handler broke the caller silently, and a dead handler stayed forever.)
test('REGRESSION (FIX-CONTRACT-REQUESTS): every handler has a contract row and every row a handler', (t) => {
  const handlers = handlerNames()
  t.is(new Set(handlers).size, handlers.length, 'no request name is registered twice')

  const missingRow = handlers.filter((h) => !REQUESTS[h])
  t.alike(missingRow, [], 'handlers with no contract row')

  const missingHandler = REQUEST_NAMES.filter((n) => !handlers.includes(n))
  t.alike(missingHandler, [], 'contract rows with no handler')
})

test('every renderer request literal names a real request', (t) => {
  const renderer = walk(path.join(root, 'src', 'renderer'))
  const unknown = new Set()
  for (const f of renderer) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/request\(\s*'([A-Za-z:.-]+)'/g)) {
      if (!REQUESTS[m[1]]) unknown.add(`${m[1]} (${path.relative(root, f)})`)
    }
  }
  t.alike([...unknown], [], 'renderer calls a request the worker does not serve')
})

test('every row is well formed', (t) => {
  const types = new Set(Object.values(ARG))
  for (const [name, spec] of Object.entries(REQUESTS)) {
    t.ok(spec.kind === 'query' || spec.kind === 'command', `${name} has a kind`)
    t.ok(spec.args && typeof spec.args === 'object', `${name} has an args shape`)
    for (const [field, rule] of Object.entries(spec.args)) {
      t.ok(types.has(rule.type), `${name}.${field} has a known arg type`)
    }
  }
})

// A ratchet, not a snapshot: deleting a dead handler is a behaviour change with its own commit, but
// nothing may be ADDED to the unreferenced list without someone noticing.
test('the unreferenced-handler list only shrinks', (t) => {
  t.ok(UNREFERENCED_REQUESTS.length <= 0, 'no new unreferenced handler was introduced')
  for (const name of UNREFERENCED_REQUESTS) t.ok(REQUESTS[name], `${name} is still a real request`)
})

// The two cancel-preview handlers were byte-identical five-line copies over one shared abort map.
// Registered from one identifier now, so the pair cannot drift: the request names are the wire
// contract and stay two, the behaviour behind them is one function.
test('the two cancel-preview request names are registered from one function', (t) => {
  const src = readFileSync(path.join(root, 'src', 'worker', 'main.js'), 'utf8')
  const bound = {}
  for (const m of src.matchAll(/ipc\.handle\('((?:owned|foreign)-folder:cancel-preview)',\s*([A-Za-z_$][\w$]*)\)/g)) {
    bound[m[1]] = m[2]
  }
  t.is(Object.keys(bound).length, 2, 'both names are registered by identifier, not by a fresh literal')
  t.is(bound['owned-folder:cancel-preview'], bound['foreign-folder:cancel-preview'],
    'and both reach the same handler')
})
