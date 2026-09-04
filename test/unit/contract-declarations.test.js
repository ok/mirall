import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath, pathToFileURL } from 'url'
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

// index.js re-exports most of the package but not all of it, and the check above only reaches what
// it re-exports — so mount-fault.d.ts declared a vocabulary nothing compared against its runtime,
// while its own header said the opposite. Per FILE, against the module it declares: a fourth
// AUTO_PAUSE_STATUSES entry would otherwise have reached the renderer's union silently.
test('every declaration file matches the module it declares', async (t) => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.d.ts') && f !== 'index.d.ts')
  t.ok(files.length >= 10, `found ${files.length} declaration files`)

  for (const file of files) {
    const dts = readFileSync(path.join(dir, file), 'utf8')
    const mod = await import(pathToFileURL(path.join(dir, file.replace(/\.d\.ts$/, '.js'))).href)

    const declared = [...dts.matchAll(/^export declare (?:const|function) ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1])
    for (const name of declared) t.ok(name in mod, `${file}: ${name} is declared but not exported at runtime`)
    for (const name of Object.keys(mod)) t.ok(declared.includes(name), `${file}: ${name} is exported but not declared`)

    // Tuples get an exact comparison for the same reason the status tuples do below: types.ts
    // derives unions with (typeof X)[number], so a drifted tuple does not mistype a value — it
    // changes which strings the renderer's exhaustive switches accept.
    for (const m of dts.matchAll(/^export declare const ([A-Za-z_$][\w$]*): readonly \[([^\]]+)\]/gm)) {
      const values = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1])
      t.alike(values, [...(mod[m[1]] ?? [])], `${file}: ${m[1]} declaration matches its implementation`)
    }
  }
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
  // Derived from the declarations rather than a hand-listed set, so a tuple added to the contract
  // is compared without anyone remembering to add it here.
  t.ok(Object.keys(declared).length >= 5, 'the declaration parse found the tuples')
  for (const [name, values] of Object.entries(declared)) {
    t.ok(Array.isArray(contract[name]), `${name} is declared as a tuple and exists at runtime`)
    t.alike(values, [...(contract[name] ?? [])], `${name} declaration matches its implementation`)
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

// The decoder grew four fields the renderer's hand-written copy never learned, and a .d.ts that
// omits a field the decoder emits hands the renderer a type that cannot see it. Derived from the
// source, so a fifth field fails here rather than in whatever screen reads it.
test('contract/invite-envelope.d.ts declares every field the decoder can emit', (t) => {
  const js = readFileSync(path.join(dir, 'invite-envelope.js'), 'utf8')
  const dts = readFileSync(path.join(dir, 'invite-envelope.d.ts'), 'utf8')
  // Scoped to the DecodedInvite declaration rather than the whole file: the encode-side field
  // list names the same fields, so a file-wide substring search passes even when the decoder's
  // own union has lost one.
  const after = dts.slice(dts.indexOf('export type DecodedInvite') + 1)
  const end = after.indexOf('\nexport ')
  const union = end === -1 ? after : after.slice(0, end)
  t.ok(union.includes('v: 1'), 'found the DecodedInvite union')

  const emitted = [...js.matchAll(/\bout\.([a-zA-Z]+)\s*=/g)].map((m) => m[1])
  t.ok(emitted.length >= 8, `the decoder emits ${emitted.length} fields`)
  for (const field of new Set(emitted)) {
    t.ok(new RegExp(`\\b${field}\\?*:`).test(union), `DecodedInvite declares ${field}`)
  }
})
