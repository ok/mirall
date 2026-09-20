import test from 'brittle'
import { createVerbosePolicy } from '../../src/shared/core/verbose-policy.js'

function policy() {
  const applied = []
  const p = createVerbosePolicy({ apply: (on) => applied.push(on) })
  return { p, applied, last: () => applied[applied.length - 1] }
}

test('verbose stays on while any client wants it', (t) => {
  const { p, last } = policy()
  p.set(1, true)
  p.set(2, true)
  p.set(2, false)
  t.is(last(), true, 'client 1 has not released')
  p.set(1, false)
  t.is(last(), false)
})

test('a departing client releases its claim', (t) => {
  const { p, last } = policy()
  p.set(1, true)
  p.set(2, true)
  p.release(1)
  t.is(last(), true, 'client 2 still wants it')
  p.release(2)
  t.is(last(), false)
})

test('releasing a client that never asked changes nothing', (t) => {
  const { p, applied } = policy()
  p.release(99)
  t.alike(applied, [], 'no write at all')
})

// REGRESSION (FIX-403-1: an earlier draft treated the boot value as an unreleasable floor. But the
// bootstrap frame carries main's LIVE debug gate, which the dev console mutates — so `verbose(true)`
// followed by any worker restart booted the next worker verbose, made that the floor, and left no
// in-app way to turn it off again for the rest of the session.)
test('REGRESSION (FIX-403-1): a client can always release what a client asked for', (t) => {
  const { p, last } = policy()
  p.set(1, true)
  p.set(1, false)
  t.is(p.effective(), false)
  t.is(last(), false, 'off means off — no floor outlives the client that raised it')
})

test('the policy does not fight a worker that booted verbose', (t) => {
  const { applied } = policy()
  t.alike(applied, [], 'no client has asked for anything, so nothing is written')
})

test('set reports the effective state, not the requested one', (t) => {
  const { p } = policy()
  p.set(1, true)
  t.is(p.set(2, false), true, 'client 2 asked for off and still gets the truth')
})
