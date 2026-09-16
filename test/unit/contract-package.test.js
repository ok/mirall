import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath, pathToFileURL } from 'url'
import path from 'path'
import { EVENT_NAMES } from '../../src/shared/contract/events.js'
import { REQUESTS, REQUEST_NAMES } from '../../src/shared/contract/requests.js'
import { CODES, CODE_NAMES } from '../../src/shared/contract/errors.js'
import { AVATAR_MAX_BYTES, NAME_MAX } from '../../src/shared/contract/limits.js'
import { emitSites, subscribeSites } from '../helpers/emit-sites.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = path.join(here, '..', '..', 'src', 'shared', 'contract')

// The package is consumed by esbuild (renderer), Bare (worker) and CJS import() (main). An import
// of anything at all would make it unusable from at least one of them, which is the entire reason
// the duplication existed in the first place.
test('the contract package imports nothing', (t) => {
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(path.join(dir, name), 'utf8')
    const imports = [...src.matchAll(/^\s*import\s+.*?from\s+'([^']+)'/gm)].map((m) => m[1])
    const external = imports.filter((i) => !i.startsWith('./'))
    t.alike(external, [], `${name} imports only its own siblings`)
  }
})

// The modules whose exports are pure vocabulary. Deliberately a list, not every file in the
// package: scope.js exports objects that are not frozen today, and invite-envelope.js exports a
// RegExp — widening this is a code change, not a test change.
const FROZEN = ['errors', 'requests', 'events', 'limits', 'statuses', 'exit-codes', 'ipc-frames', 'peer-frames', 'main-requests', 'workers', 'audit-kinds', 'reachability']

test('every vocabulary is frozen', async (t) => {
  for (const name of FROZEN) {
    const mod = await import(pathToFileURL(path.join(dir, name + '.js')).href)
    for (const [key, value] of Object.entries(mod)) {
      if (value && typeof value === 'object') {
        t.ok(Object.isFrozen(value), `${name}.js: ${key} is frozen — a consumer mutating it would rewrite the contract for everyone`)
      }
    }
  }
})

test('the runtime kinds are what the renderer derives from', (t) => {
  t.ok(Array.isArray(REQUEST_NAMES), 'REQUEST_NAMES is an array')
  t.ok(Array.isArray(CODE_NAMES), 'CODE_NAMES is an array')
  t.is(typeof AVATAR_MAX_BYTES, 'number', 'AVATAR_MAX_BYTES is a number')
  t.is(typeof NAME_MAX, 'number', 'NAME_MAX is a number')
  t.is(typeof CODES, 'object', 'CODES is a record')
  t.is(typeof REQUESTS, 'object', 'REQUESTS is a record')
})

// types.ts must keep deriving rather than re-listing: a hand-written union next to the contract is
// exactly the twin this package exists to delete.
test('the renderer derives its status unions instead of re-listing them', (t) => {
  const types = readFileSync(path.join(dir, '..', '..', 'renderer', 'types', 'types.ts'), 'utf8')
  for (const [type, konst] of [['FileStatus', 'FILE_STATUSES'], ['BadgeStatus', 'BADGE_STATUSES'], ['ShareFileStatus', 'SHARE_FILE_STATUSES'], ['AuditCategory', 'CATEGORIES'], ['ReachabilityVerdict', 'VERDICTS'], ['ReachabilityCause', 'CAUSES'], ['CanaryState', 'CANARY_STATES']]) {
    t.ok(new RegExp(`export type ${type} = \\(typeof ${konst}\\)\\[number\\]`).test(types),
      `${type} is derived from the contract`)
  }
})

// REGRESSION (FIX-EVENTS-1: this guard matched the TEXT /\.emit\('(event:[a-z-]+)'/ — a leading
// dot and single quotes. src/shared/core/hints.js calls `emit('event:reconcile', …)` on a bare
// parameter, so the one missing punctuation mark hid the fan-in point of the entire
// level-triggered reconcile channel, and the contract reported itself complete. The scan now
// parses; quote style, optional chaining and the receiver's shape cannot hide a site.
//
// Three directions, because a one-way guard only measures half a contract: an undeclared emit is
// drift, a declared name nobody emits is dead vocabulary, and a renderer subscribed to a name
// nothing emits waits forever. The last one is what would have caught event:reconcile from the
// other end.
const DATA_LAYER = ['shared', 'worker', 'main']

function walkSrc(dir, pattern, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'vendor' && name !== 'contract') walkSrc(p, pattern, out) }
    else if (pattern.test(name)) out.push(p)
  }
  return out
}

function collect(dirs, pattern, scan) {
  const found = new Map()
  for (const d of dirs) {
    for (const f of walkSrc(path.join(dir, '..', '..', d), pattern)) {
      for (const name of scan(readFileSync(f, 'utf8'), f)) {
        if (!found.has(name)) found.set(name, [])
        found.get(name).push(path.relative(process.cwd(), f))
      }
    }
  }
  return found
}

test('REGRESSION (FIX-EVENTS-1): a bare emit() is seen by the contract guard', (t) => {
  const seen = (src) => [...emitSites(src, 'fixture.js')]
  t.alike(seen("emit('event:x', {})"), ['event:x'], 'a bare emit on a parameter is seen')
  t.alike(seen('bus.emit("event:y", {})'), ['event:y'], 'double quotes are seen')
  t.alike(seen('bus?.emit(`event:z`, {})'), ['event:z'], 'optional chaining and a template are seen')
  t.alike(seen("this.ipc.emit('event:w')"), ['event:w'], 'a nested receiver is seen')
  t.alike(seen("bus['emit']('event:v')"), ['event:v'], 'a computed member is seen')
  t.alike(seen("emit(name, {})"), [], 'a name assembled at runtime is not a declaration')
  t.alike(seen("emit('not-an-event')"), [], 'a non-event call is not collected')
  t.alike(seen('const emit = 1'), [], 'a mention that is not a call is not collected')
})

test('every event the worker emits is declared in the contract', (t) => {
  const emitted = collect(DATA_LAYER, /\.js$/, emitSites)
  t.ok(emitted.size > 10, 'the data layer was actually walked')
  const undeclared = [...emitted.keys()].filter((e) => !EVENT_NAMES.includes(e)).sort()
    .map((e) => `${e} (${emitted.get(e).join(', ')})`)
  t.alike(undeclared, [], 'events emitted but absent from the contract')
})

// The reverse direction, which was never measured. Empty today; a name that stops being emitted
// should lose its contract row in the same commit, not linger as vocabulary nothing speaks.
test('every declared event is emitted somewhere', (t) => {
  const emitted = collect(DATA_LAYER, /\.js$/, emitSites)
  const dead = EVENT_NAMES.filter((e) => !emitted.has(e)).sort()
  t.alike(dead, [], 'events declared in the contract that nothing emits')
})

// The renderer imports no leaf of the contract, so nothing else relates what it listens for to
// what the worker sends. A subscription to a name nothing emits is a screen that never updates.
test('every renderer subscription names a declared event', (t) => {
  const subscribed = collect(['renderer'], /\.(js|ts|tsx)$/, subscribeSites)
  t.ok(subscribed.size > 10, 'src/renderer was actually walked')
  const unknown = [...subscribed.keys()].filter((e) => !EVENT_NAMES.includes(e)).sort()
    .map((e) => `${e} (${subscribed.get(e).join(', ')})`)
  t.alike(unknown, [], 'the renderer waits for an event the contract does not declare')
})
