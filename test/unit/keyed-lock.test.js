import test from 'brittle'
import { createKeyedLock } from '../../src/shared/core/keyed-lock.js'

test('runExclusive runs one key in call order, other keys in parallel, and releases drained keys', async (t) => {
  const lock = createKeyedLock()
  const order = []
  const a = lock('k', async () => { await new Promise((r) => setTimeout(r, 20)); order.push('a') })
  const b = lock('k', async () => { order.push('b') })
  const c = lock('other', async () => { order.push('c') })
  t.is(lock.pending(), 2, 'two keys in flight')
  await Promise.all([a, b, c])
  t.alike(order, ['c', 'a', 'b'], 'same key waits; another key does not')
  await new Promise((r) => setTimeout(r, 0))
  t.is(lock.pending(), 0, 'no entry lingers for a drained key')
})

test('a rejection reaches its caller and does not poison the chain', async (t) => {
  const lock = createKeyedLock()
  await t.exception(lock('k', async () => { throw new Error('boom') }), /boom/)
  t.is(await lock('k', async () => 'after'), 'after', 'the next call on the same key still runs')
})
