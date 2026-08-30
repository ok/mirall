import test from 'brittle'
import { createIntentLog, INTENT_PREFIX } from '../../src/shared/core/intents.js'

// A minimal in-memory stand-in for the Hyperbee surface the log uses: put, del, createReadStream
// over a key range. Keeps this a Node unit test — the log has no bare-* imports by design.
function fakeBee () {
  const map = new Map()
  return {
    map,
    async put (k, v) { map.set(k, v) },
    async del (k) { map.delete(k) },
    async * createReadStream ({ gte, lt }) {
      for (const key of [...map.keys()].sort()) {
        if (key >= gte && key < lt) yield { key, value: map.get(key) }
      }
    },
  }
}

const logOf = () => { const lines = []; return { lines, warn: (...a) => lines.push(['warn', ...a].join(' ')), info: (...a) => lines.push(['info', ...a].join(' ')) } }

test('an intent is written before the flow and removed after it', async (t) => {
  const bee = fakeBee()
  const intents = createIntentLog({ bee: () => bee })
  intents.register('owned-delete', async () => {})

  const id = await intents.begin('owned-delete', { spaceId: 's1', shareId: 'sh1' })
  t.ok(id.startsWith(INTENT_PREFIX + 'owned-delete/'), 'the id carries the kind')
  t.is(bee.map.size, 1, 'the record exists while the flow runs')
  t.alike((await intents.list())[0].args, { spaceId: 's1', shareId: 'sh1' }, 'and carries the args')

  await intents.complete(id)
  t.is(bee.map.size, 0, 'and is gone once the flow finishes')
})

test('completing twice is not an error', async (t) => {
  const bee = fakeBee()
  const intents = createIntentLog({ bee: () => bee })
  intents.register('k', async () => {})
  const id = await intents.begin('k', {})
  await intents.complete(id)
  await intents.complete(id)
  t.is(bee.map.size, 0, 'idempotent')
})

test('beginning an unregistered kind throws at the call site', async (t) => {
  const bee = fakeBee()
  const intents = createIntentLog({ bee: () => bee })
  let threw = null
  try { await intents.begin('typo', {}) } catch (err) { threw = err }
  t.ok(threw, 'refused')
  t.ok(/no reconciler registered/.test(threw.message), 'and says why')
  t.is(bee.map.size, 0, 'no orphan record was written')
})

test('registering the same kind twice throws', (t) => {
  const intents = createIntentLog({ bee: () => fakeBee() })
  intents.register('k', async () => {})
  let threw = null
  try { intents.register('k', async () => {}) } catch (err) { threw = err }
  t.ok(threw, 'a duplicate reconciler is a wiring bug, not a silent overwrite')
})

test('recover dispatches by kind and clears only what completed', async (t) => {
  const bee = fakeBee()
  const intents = createIntentLog({ bee: () => bee, log: logOf() })
  const seen = []
  intents.register('a', async (args) => { seen.push(['a', args]) })
  intents.register('b', async (args) => { seen.push(['b', args]) })

  await intents.begin('a', { n: 1 })
  await intents.begin('b', { n: 2 })
  await intents.recover()

  t.is(seen.length, 2, 'both reconcilers ran')
  t.alike(seen.map((s) => s[0]).sort(), ['a', 'b'])
  t.is(bee.map.size, 0, 'both records cleared')
})

// REGRESSION (FIX-INTENT-ISOLATION: one wedged flow must not strand every other pending intent —
// the contract resumeInterruptedLeave already kept for its own steps.)
test('REGRESSION (FIX-INTENT-ISOLATION): a throwing reconciler keeps its record and does not stop the rest', async (t) => {
  const bee = fakeBee()
  const log = logOf()
  const intents = createIntentLog({ bee: () => bee, log })
  const ran = []
  intents.register('bad', async () => { throw new Error('disk on fire') })
  intents.register('good', async () => { ran.push('good') })

  await intents.begin('bad', {})
  await intents.begin('good', {})
  await intents.recover()

  t.alike(ran, ['good'], 'the healthy intent still ran')
  const left = await intents.list()
  t.is(left.length, 1, 'exactly one record survived')
  t.is(left[0].kind, 'bad', 'the failed one, kept for the next boot')
  t.ok(log.lines.some((l) => l.includes('retrying next boot')), 'and it said so')
})

// Forward compatibility: an older build must never eat a record it does not understand.
test('an intent whose kind is unknown survives untouched', async (t) => {
  const bee = fakeBee()
  const log = logOf()
  const intents = createIntentLog({ bee: () => bee, log })
  intents.register('known', async () => {})
  await intents.begin('known', {})
  // A newer build's record, written by a version that had a reconciler for it.
  await bee.put(INTENT_PREFIX + 'from-the-future/123-0', { kind: 'from-the-future', args: {}, at: 1 })

  await intents.recover()

  const left = await intents.list()
  t.is(left.length, 1, 'the unknown record is still there')
  t.is(left[0].kind, 'from-the-future')
  t.ok(log.lines.some((l) => l.includes('no reconciler')), 'and it was reported, not dropped')
})

test('ids are unique within a millisecond', async (t) => {
  const bee = fakeBee()
  const intents = createIntentLog({ bee: () => bee })
  intents.register('k', async () => {})
  const ids = new Set()
  for (let i = 0; i < 100; i++) ids.add(await intents.begin('k', { i }))
  t.is(ids.size, 100, 'no collisions')
  t.is((await intents.list()).length, 100, 'and every one is listed')
})

// A flow must not fail because its bookkeeping write failed: refusing the user's delete is a worse
// outcome than the crash window the intent guards against.
test('beginOrNull degrades to the pre-intent behaviour when the write fails', async (t) => {
  const bee = fakeBee()
  bee.put = async () => { throw new Error('bee closed') }
  const log = logOf()
  const intents = createIntentLog({ bee: () => bee, log })
  intents.register('owned-delete', async () => {})

  const id = await intents.beginOrNull('owned-delete', {})
  t.is(id, null, 'the caller gets null instead of a rejection')
  t.ok(log.lines.some((l) => l.includes('runs unprotected')), 'and it is reported')
})

test('complete tolerates a null id and a failing delete', async (t) => {
  const bee = fakeBee()
  const log = logOf()
  const intents = createIntentLog({ bee: () => bee, log })
  await intents.complete(null)
  t.pass('a null id is a no-op, so the caller needs no branch')

  intents.register('k', async () => {})
  const id = await intents.begin('k', {})
  bee.del = async () => { throw new Error('disk gone') }
  await intents.complete(id)
  t.pass('a failing clear does not throw out of a flow whose work is already done')
  t.ok(log.lines.some((l) => l.includes('re-run harmlessly')), 'and says the record will re-run')
})
