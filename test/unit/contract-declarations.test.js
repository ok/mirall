import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import * as contract from '../../src/shared/contract/index.js'

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

// REGRESSION (FIX-CONTRACT-DRIFT: TypeScript never compares a .js against its own .d.ts — the
// declaration shadows the implementation. Measured: PROBE declared readonly string[] and implemented
// as 42 type-checks clean. A contract built that way would hand the renderer confident types with no
// runtime backing, which is worse than the duplication it replaces.)
test('REGRESSION (FIX-CONTRACT-DRIFT): every declared export exists at runtime', (t) => {
  const dts = readFileSync(path.join(dir, 'index.d.ts'), 'utf8')
  const declared = new Set()
  for (const m of dts.matchAll(/export\s+\{([^}]+)\}/g)) {
    for (const name of m[1].split(',')) {
      const clean = name.trim().split(/\s+as\s+/).pop().trim()
      if (clean && clean !== 'type') declared.add(clean)
    }
  }
  declared.delete('ArgType'); declared.delete('ArgRule'); declared.delete('RequestSpec')

  for (const name of declared) t.ok(name in contract, `${name} is declared but not exported at runtime`)
  for (const name of Object.keys(contract)) t.ok(declared.has(name), `${name} is exported but not declared`)
})

test('every vocabulary is frozen', (t) => {
  for (const [name, value] of Object.entries(contract)) {
    if (value && typeof value === 'object') {
      t.ok(Object.isFrozen(value), `${name} is frozen — a consumer mutating it would rewrite the contract for everyone`)
    }
  }
})

test('the declared types match the runtime kinds', (t) => {
  t.ok(Array.isArray(contract.REQUEST_NAMES), 'REQUEST_NAMES is an array')
  t.ok(Array.isArray(contract.CODE_NAMES), 'CODE_NAMES is an array')
  t.is(typeof contract.AVATAR_MAX_BYTES, 'number', 'AVATAR_MAX_BYTES is a number')
  t.is(typeof contract.NAME_MAX, 'number', 'NAME_MAX is a number')
  t.is(typeof contract.CODES, 'object', 'CODES is a record')
  t.is(typeof contract.REQUESTS, 'object', 'REQUESTS is a record')
})

// The status tuples are load-bearing in a way the other exports are not: types.ts derives its unions
// with (typeof X)[number], so a .d.ts that drifts from the .js does not just mistype a value — it
// silently changes which strings the renderer's exhaustive switches accept.
test('the declared status tuples match the runtime arrays exactly', (t) => {
  const dts = readFileSync(path.join(dir, 'statuses.d.ts'), 'utf8')
  const declared = {}
  for (const m of dts.matchAll(/export declare const ([A-Z_]+): readonly \[([^\]]+)\]/g)) {
    declared[m[1]] = [...m[2].matchAll(/'([a-z-]+)'/g)].map((x) => x[1])
  }
  const runtime = { FILE_STATUS: contract.FILE_STATUS, BADGE_STATUS: contract.BADGE_STATUS, SHARE_FILE_STATUS: contract.SHARE_FILE_STATUS }
  for (const [name, values] of Object.entries(runtime)) {
    t.alike(declared[name], [...values], `${name} declaration matches its implementation`)
  }
})

// types.ts must keep deriving rather than re-listing: a hand-written union next to the contract is
// exactly the twin this package exists to delete.
test('the renderer derives its status unions instead of re-listing them', (t) => {
  const types = readFileSync(path.join(dir, '..', '..', 'renderer', 'types.ts'), 'utf8')
  for (const [type, konst] of [['FileStatus', 'FILE_STATUS'], ['BadgeStatus', 'BADGE_STATUS'], ['ShareFileStatus', 'SHARE_FILE_STATUS']]) {
    t.ok(new RegExp(`export type ${type} = \\(typeof ${konst}\\)\\[number\\]`).test(types),
      `${type} is derived from the contract`)
  }
})

// The EVENTS list claimed to be guarded and was not. Rather than soften the comment, this is the
// guard: an emit site the contract does not know is drift, and the list is only useful if it is
// complete.
test('every event the worker emits is declared in the contract', (t) => {
  const src = path.join(dir, '..', '..')
  const files = []
  const walkAll = (d) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name)
      if (statSync(p).isDirectory()) { if (name !== 'vendor' && name !== 'contract') walkAll(p) }
      else if (name.endsWith('.js')) files.push(p)
    }
  }
  walkAll(path.join(src, 'shared'))
  walkAll(path.join(src, 'worker'))

  const emitted = new Set()
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(/\.emit\('(event:[a-z-]+)'/g)) emitted.add(m[1])
  }
  const undeclared = [...emitted].filter((e) => !contract.EVENT_NAMES.includes(e)).sort()
  t.alike(undeclared, [], 'events emitted but absent from the contract')
})

// The RequestName union is what makes request() type-safe; declared as Record<string, …> it would
// be `string` and a typo would compile. Generated from requests.js, so it must equal it exactly —
// a union that silently rots is how `setVerbose` escaped the contract in the first place.
test('the declared RequestName union matches the request rows exactly', (t) => {
  const dts = readFileSync(path.join(dir, 'requests.d.ts'), 'utf8')
  const block = dts.slice(dts.indexOf('export type RequestName ='), dts.indexOf('export type ArgType'))
  const declared = [...block.matchAll(/\|\s*'([^']+)'/g)].map((m) => m[1]).sort()
  t.alike(declared, Object.keys(contract.REQUESTS).sort(), 'every request row has a declared name and vice versa')
})
