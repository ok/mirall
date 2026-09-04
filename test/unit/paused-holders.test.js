import test from 'brittle'
import { createPausedHolders } from '../../src/shared/transfer/backends/overlay/paused-holders.js'

function spy () {
  const calls = []
  return { fn: (h) => calls.push(h), calls }
}

test('a stop with no pause marker notifies nobody', (t) => {
  const s = spy()
  const p = createPausedHolders({ notifyStopped: s.fn })
  t.is(p.stop('k'), false)
  t.is(s.calls.length, 0)
})

// The whole reason the marker outlives the single-flight slot.
test('a pause then a stop tells the holder we stopped', (t) => {
  const s = spy()
  const p = createPausedHolders({ notifyStopped: s.fn })
  p.remember('k', 'hash-a')
  t.is(p.stop('k'), true)
  t.alike(s.calls, ['hash-a'])
  t.is(p.stop('k'), false, 'and the marker is consumed, so a second stop is silent')
})

test('a resumed fetch supersedes the marker', (t) => {
  const s = spy()
  const p = createPausedHolders({ notifyStopped: s.fn })
  p.remember('k', 'hash-a')
  p.supersede('k')
  t.is(p.stop('k'), false, 'the resumed fetch owns the holder relationship now')
  t.is(s.calls.length, 0)
})

test('the newest pause wins for a key', (t) => {
  const s = spy()
  const p = createPausedHolders({ notifyStopped: s.fn })
  p.remember('k', 'hash-a')
  p.remember('k', 'hash-b')
  p.stop('k')
  t.alike(s.calls, ['hash-b'], 'never the stale hash')
})

// A pause with no live transfer still records the user's intent — it just has no holder to tell.
test('a hash-less marker is still a marker', (t) => {
  const s = spy()
  const p = createPausedHolders({ notifyStopped: s.fn })
  p.remember('k', null)
  t.is(p.has('k'), true, 'the intent is recorded, which is what suppresses auto-resume')
  t.is(p.peek('k'), null)
  t.is(p.notify('k'), false, 'but there is nothing to notify')
  t.is(s.calls.length, 0)
})

// The engine notifies BEFORE clearing its durable row and only supersedes after, so that a failed
// clear cannot drop a marker whose absence would auto-resume a transfer the user paused.
test('notify leaves the marker; supersede removes it', (t) => {
  const s = spy()
  const p = createPausedHolders({ notifyStopped: s.fn })
  p.remember('k', 'hash-a')
  t.is(p.notify('k'), true)
  t.is(p.has('k'), true, 'still marked — the durable clear has not landed yet')
  t.alike(s.calls, ['hash-a'])
  p.supersede('k')
  t.is(p.has('k'), false)
})

test('has() distinguishes an unmarked key from a hash-less one', (t) => {
  const p = createPausedHolders({ notifyStopped: () => {} })
  t.is(p.has('never'), false)
  t.is(p.peek('never'), null)
  p.remember('marked', null)
  t.is(p.has('marked'), true, 'a null hash and no marker at all are different states')
})

test('a throwing notifier is contained', (t) => {
  const p = createPausedHolders({ notifyStopped: () => { throw new Error('overlay is gone') } })
  p.remember('k', 'h')
  t.is(p.stop('k'), false, 'reports failure')
  t.execution(() => p.stop('k'), 'and never propagates — a teardown must not fail on a notify')
})

test('keys are independent and clear drops all', (t) => {
  const s = spy()
  const p = createPausedHolders({ notifyStopped: s.fn })
  p.remember('a', 'ha')
  p.remember('b', 'hb')
  p.stop('a')
  t.is(p.peek('b'), 'hb')
  p.clear()
  t.is(p.has('b'), false)
})
