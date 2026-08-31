import test from 'brittle'
import { createCancellation, throwIfAborted } from '../../src/shared/core/cancellation.js'

test('the token matches the shape every existing consumer already reads', (t) => {
  const c = createCancellation()
  t.is(c.signal.aborted, false)
  c.abort()
  t.is(c.signal.aborted, true, 'walk-disk.js, publish-queue.js and prepareFile all test exactly this')
})

test('abort is idempotent and notifies each listener once', (t) => {
  const c = createCancellation()
  let n = 0
  c.signal.onAbort(() => { n++ })
  c.abort(new Error('first'))
  c.abort(new Error('second'))
  t.is(n, 1, 'the second abort is a no-op')
  t.is(c.signal.reason.message, 'first', 'the first reason wins')
})

test('a listener added after the abort fires immediately', (t) => {
  const c = createCancellation()
  c.abort(new Error('gone'))
  let seen = null
  c.signal.onAbort((r) => { seen = r })
  t.is(seen?.message, 'gone', 'no listener can miss an abort by subscribing late')
})

test('onAbort returns an unsubscribe that actually detaches', (t) => {
  const c = createCancellation()
  let fired = false
  const off = c.signal.onAbort(() => { fired = true })
  off()
  c.abort()
  t.absent(fired, 'a caller that finished normally leaves nothing behind on a shared signal')
})

test('a throwing listener does not stop the others', (t) => {
  const c = createCancellation()
  let reached = false
  c.signal.onAbort(() => { throw new Error('bad subscriber') })
  c.signal.onAbort(() => { reached = true })
  c.abort()
  t.ok(reached, 'and it never reaches the crash backstop, whose fault window exits the worker')
})

test('throwIfAborted throws ECANCELLED, or the abort reason when it carries one', (t) => {
  t.execution(() => throwIfAborted(null), 'a null signal is not an abort')
  t.execution(() => throwIfAborted(undefined), 'nor is a missing one')
  const c = createCancellation()
  t.execution(() => throwIfAborted(c.signal), 'not aborted yet')
  c.abort()
  t.exception(() => throwIfAborted(c.signal), /cancelled/)
  try {
    throwIfAborted(c.signal)
    t.fail('expected a throw')
  } catch (err) {
    t.is(err.code, 'ECANCELLED', 'the code ipc.js classifies as EXPECTED, so it logs at debug')
  }
  const c2 = createCancellation()
  c2.abort(new Error('peer read gave up'))
  try {
    throwIfAborted(c2.signal)
    t.fail('expected a throw')
  } catch (err) {
    t.is(err.message, 'peer read gave up', 'a specific reason survives the checkpoint')
  }
})
