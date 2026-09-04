import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { createRecordWriter } from '../../src/shared/core/bee-writer.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')

// The shape hyperbee actually presents: get() resolves a { seq, key, value } node or null, cas is
// invoked ONLY when the key already exists, and a falsy cas return makes put a silent no-op.
function fakeBee () {
  const rows = new Map()
  let seq = 0
  const bee = {
    async get (key) { return rows.get(key) ?? null },
    async put (key, value, opts) {
      const prev = rows.get(key)
      if (prev && opts?.cas && !(await opts.cas(prev, { seq: seq + 1, key, value }))) return
      rows.set(key, { seq: ++seq, key, value })
    },
    async del (key) { rows.delete(key) },
  }
  return {
    get: (key) => rows.get(key)?.value ?? null,
    seqOf: (key) => rows.get(key)?.seq ?? null,
    seed: (key, value) => rows.set(key, { seq: ++seq, key, value }),
    // A writer that bypassed the lock, which is the only thing cas exists to catch.
    bumpOutside: (key) => { rows.set(key, { ...rows.get(key), seq: ++seq }) },
    writer: (opts) => createRecordWriter({ bee: () => bee, ...opts }),
  }
}

// REGRESSION (FIX-R05-2: every read-modify-write of a mount record was get -> spread -> put. Two
// continuations interleaving read the same value and the second put drops the first one's field —
// and the dropped field was always a status latch: a pause, an enabled flag, an error, a path.)
test('REGRESSION (FIX-R05-2): two concurrent mutations both survive', async (t) => {
  const b = fakeBee()
  b.seed('k', { base: true })
  const w = b.writer()

  await Promise.all([
    w.mutate('k', (m) => ({ ...m, a: 1 })),
    w.mutate('k', (m) => ({ ...m, b: 2 })),
  ])

  t.alike(b.get('k'), { base: true, a: 1, b: 2 }, 'neither write was lost')
})

test('a mutation on a missing record is the documented no-op', async (t) => {
  const b = fakeBee()
  t.is(await b.writer().mutate('gone', () => ({ x: 1 })), false, 'reports false')
  t.is(b.get('gone'), null, 'and writes nothing — a create must not go through mutate')
})

test('an apply that declines succeeds without writing', async (t) => {
  const b = fakeBee()
  b.seed('k', { status: 'active' })
  const before = b.seqOf('k')
  t.is(await b.writer().mutate('k', () => null), true, 'reports success')
  t.is(b.seqOf('k'), before, 'and appended no block — this is what keeps a probe tick from writing every second')
})

test('a record changed outside the lock is retried, not lost', async (t) => {
  const b = fakeBee()
  b.seed('k', { n: 0 })
  let applies = 0
  const w = b.writer({ log: { warn () {} } })

  await w.mutate('k', (m) => {
    if (applies++ === 0) b.bumpOutside('k')
    return { ...m, n: m.n + 1 }
  })

  t.is(applies, 2, 'the first attempt was superseded and re-read')
  t.alike(b.get('k'), { n: 1 }, 'and the retry committed the intended value')
})

test('a record changed outside the lock on every attempt throws rather than losing the update', async (t) => {
  const b = fakeBee()
  b.seed('k', { n: 0 })
  const w = b.writer({ log: { warn () {} } })

  await t.exception(
    () => w.mutate('k', (m) => { b.bumpOutside('k'); return { ...m, n: 1 } }),
    /after 3 attempts/,
    'loud — a silent give-up here is the lost update this exists to prevent',
  )
})

test('mutations on different keys do not serialize against each other', async (t) => {
  const b = fakeBee()
  b.seed('slow', { v: 0 })
  b.seed('fast', { v: 0 })
  const w = b.writer()

  let release
  const gate = new Promise((resolve) => { release = resolve })
  const slow = w.mutate('slow', (m) => ({ ...m, v: 1 }))
  const blocked = w.mutate('slow', async () => { await gate; return null })
  await w.mutate('fast', (m) => ({ ...m, v: 1 }))

  t.alike(b.get('fast'), { v: 1 }, 'an unrelated key completed while another was held')
  release()
  await Promise.all([slow, blocked])
})

test('a throwing apply rejects its own caller and does not poison the chain', async (t) => {
  const b = fakeBee()
  b.seed('k', { v: 0 })
  const w = b.writer()

  await t.exception(() => w.mutate('k', () => { throw new Error('apply failed') }), /apply failed/)
  await w.mutate('k', (m) => ({ ...m, v: 1 }))
  t.alike(b.get('k'), { v: 1 }, 'the next write on the same key still runs')
})

test('deletes and creates take the same lock as the mutations', async (t) => {
  const b = fakeBee()
  b.seed('k', { v: 0 })
  const w = b.writer()

  // The window cas cannot see: it is never invoked for an absent key, so a delete landing between a
  // mutation's read and its write would be undone by that write.
  await Promise.all([w.mutate('k', (m) => ({ ...m, v: 1 })), w.del('k')])
  t.is(b.get('k'), null, 'the record stays deleted — the mutation did not resurrect it')
})

function walk (dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(js|ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

// A ratchet, not a snapshot: the bypass is what keeps re-creating the bug, so make it visible the
// moment someone reintroduces it.
test('REGRESSION (FIX-R05-2): no mount record is written outside the serialized path', (t) => {
  const store = readFileSync(path.join(root, 'src/shared/folders/mount-store.js'), 'utf8')
  t.is([...store.matchAll(/\bbee\.(put|del)\(/g)].length, 0,
    'mount-store writes only through the record writer')

  const outside = []
  for (const f of walk(path.join(root, 'src'))) {
    if (/\b(saveOwnedMount|saveForeignMount)\b/.test(readFileSync(f, 'utf8'))) outside.push(path.relative(root, f))
  }
  t.alike(outside, [], 'the whole-record writers are gone — creates go through create*, updates through patch*/mutate*')
})
